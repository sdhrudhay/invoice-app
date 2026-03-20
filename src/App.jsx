import { useState, useEffect, useRef, useCallback } from "react";

// Safe env var access (works in Vite, CRA, and plain browser)
const getEnv = (key) => { try { return import.meta?.env?.[key] || ""; } catch(e) { return ""; } };

// ─── Helpers ─────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, days) => { const d = new Date(dateStr); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); };
const fmt = (n) => Number(n || 0).toFixed(2);
const num = (v) => parseFloat(v) || 0;
const yyyymm = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}`; };
const yyyy = () => String(new Date().getFullYear());
const yyyymmdd = () => { const d=new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`; };

// ─── Order Number Generation ──────────────────────────────────────────────────
function buildOrderNo(series, type, orders) {
  const { prefix, format, digits } = series;
  const periodPart = format === "YYYYMM" ? yyyymm() : format === "YYYY" ? yyyy() : format === "YYYYMMDD" ? yyyymmdd() : "";
  const base = [prefix, periodPart].filter(Boolean).join("/");
  const existing = orders.filter(o => o.orderNoBase === base && o.type === type);
  const seq = String(existing.length + 1).padStart(Number(digits) || 6, "0");
  const typeSuffix = type === "B2B" ? "-B" : "";
  return `${base}/${seq}${typeSuffix}`;
}

function genInvNo(prefix, period, list, digits) {
  const base = period ? `${prefix}/${period}` : prefix;
  const count = list.filter(i => i.invNoBase === base).length + 1;
  return { invNo: `${base}/${String(count).padStart(digits, "0")}`, invNoBase: base };
}

function genClientId(clients=[]) {
  const n = clients.length + 1;
  return "CLT-" + String(n).padStart(4,"0");
}

const EMPTY_CLIENT = { id:"", name:"", gstin:"", contact:"", email:"", billingName:"", billingAddress:"", billingStateCode:"", placeOfSupply:"", shippingName:"", shippingContact:"", shippingGstin:"", shippingAddress:"", shippingStateCode:"", clientType:"B2B" };

const EMPTY_ITEM = { sl: 1, item: "", hsn: "", unit: "Nos", unitPrice: "", qty: "", discount: "", grossAmt: 0, cgstRate: 9, cgstAmt: 0, sgstRate: 9, sgstAmt: 0, netAmt: 0 };

function calcItem(it, needsGst=true) {
  const gross = num(it.unitPrice) * num(it.qty) * (1 - num(it.discount) / 100);
  const cgst = needsGst ? (gross * num(it.cgstRate)) / 100 : 0;
  const sgst = needsGst ? (gross * num(it.sgstRate)) / 100 : 0;
  return { ...it, grossAmt: gross, cgstAmt: cgst, sgstAmt: sgst, netAmt: gross + cgst + sgst };
}

// Merge invoice items into an existing order items list.
// Existing items (matched by name) are kept as-is; new items are appended.
function mergeItemsIntoOrder(orderItems, invoiceItems) {
  const existing = orderItems.map(i=>({...i}));
  const existingNames = new Set(existing.map(i=>(i.item||"").toLowerCase().trim()));
  const toAdd = invoiceItems.filter(i => i.item && !existingNames.has((i.item||"").toLowerCase().trim()));
  const renumbered = [...existing, ...toAdd].map((i,idx)=>({...i, sl:idx+1}));
  return renumbered;
}

const PAYMENT_MODES = ["Cash", "UPI", "Card", "Bank Transfer", "Cheque"];
const GST_RATES = [0, 2.5, 6, 9, 14];
const STATUS_OPTIONS = ["Pending", "Completed", "Cancelled"];

const DEFAULT_SELLER = {
  name: "Your Company Name", gstin: "29XXXXX0000X1ZX",
  address: "123, Business Park, Bengaluru, Karnataka - 560001",
  state: "Karnataka", stateCode: "29", phone: "+91 98765 43210",
  email: "billing@yourcompany.com", bank: "HDFC Bank",
  accountNo: "XXXXXXXXXXXX", ifsc: "HDFC0001234", logo: "",
  pfTerms: "1. This proforma invoice is valid for 15 days from the date of issue.\n2. 50% advance payment required to confirm the order.\n3. Prices are subject to change without prior notice.\n4. Delivery timelines will be confirmed upon order confirmation.",
  tiTerms: "1. Payment due within 30 days from invoice date.\n2. Goods once sold will not be taken back or exchanged.\n3. Interest @18% p.a. will be charged on overdue payments.\n4. Subject to local jurisdiction only.",
  signatory: "",
  filamentPrices: {},
};

const DEFAULT_SERIES = {
  prefix: "ORD", format: "YYYYMMDD", digits: "6",
  qtPrefix: "QT", qtFormat: "YYYYMMDD", qtDigits: "6",
  pfPrefix: "EA-PF", pfFormat: "YYYYMMDD",
  tiPrefix: "EA-TAX", tiFormat: "YYYYMMDD", invDigits: "6",
};


// ─── Apps Script Code ─────────────────────────────────────────────────────────



const SUPABASE_SQL = `
-- Orders
-- Migration: run in Supabase SQL editor:
-- create table if not exists products (id text primary key, name text, hsn text default '', brand text default '', material text default '', weight_g numeric default 0, unit_price numeric default 0, product_type text default '3d_printed', cgst_rate numeric default 9, sgst_rate numeric default 9, notes text default '', created_at timestamptz default now());
-- alter table products add column if not exists unit_price numeric default 0;
-- alter table products add column if not exists product_type text default '3d_printed';
-- 
-- alter table orders add column if not exists filament_usage text default '[]';
-- alter table orders add column if not exists charges text default '[]';
create table if not exists orders (
  order_no text primary key, order_no_base text, type text, customer_name text,
  phone text, email text, gstin text, billing_name text, billing_address text,
  billing_state_code text, shipping_name text, shipping_address text,
  shipping_contact text, shipping_gstin text, shipping_state_code text,
  place_of_supply text, order_date text, due_date text, payment_mode text,
  advance numeric default 0, advance_recipient text, advance_txn_ref text,
  status text, comments text, needs_gst boolean default true,
  quotation_no text, proforma_ids text, tax_invoice_ids text,
  filament_usage text default '[]', charges text default '[]',
  created_at timestamptz default now()
);
-- Run in Supabase:
-- alter table quotations add column if not exists order_snapshot text;
-- alter table proformas add column if not exists order_snapshot text;
-- alter table tax_invoices add column if not exists order_snapshot text;
-- Quotations
create table if not exists quotations (
  inv_no text primary key, inv_no_base text, inv_date text,
  order_id text, amount numeric default 0, notes text, seller_snapshot text,
  created_at timestamptz default now()
);
-- Proformas
create table if not exists proformas (
  inv_no text primary key, inv_no_base text, inv_date text,
  order_id text, amount numeric default 0, notes text, seller_snapshot text,
  created_at timestamptz default now()
);
-- Tax Invoices
create table if not exists tax_invoices (
  inv_no text primary key, inv_no_base text, inv_date text,
  order_id text, amount numeric default 0, notes text, seller_snapshot text,
  created_at timestamptz default now()
);
-- Normalized Items (covers all document types)
create table if not exists items (
  id text primary key,
  document_type text not null, -- "order"|"quotation"|"proforma"|"tax_invoice"
  document_id text not null,   -- order_no or inv_no
  sl integer, item text, hsn text, unit text,
  unit_price numeric default 0, qty numeric default 0, discount numeric default 0,
  gross_amt numeric default 0, cgst_rate numeric default 0, cgst_amt numeric default 0,
  sgst_rate numeric default 0, sgst_amt numeric default 0, net_amt numeric default 0,
  brand text default '', material text default '', product_id text default '',
  created_at timestamptz default now()
);
-- Migration: alter table items add column if not exists brand text default '';
-- Migration: alter table items add column if not exists material text default '';
-- Migration: alter table items add column if not exists product_id text default '';
create index if not exists items_doc_idx on items(document_type, document_id);
-- Clients
create table if not exists clients (
  id text primary key, name text, gstin text, contact text, email text,
  billing_name text, billing_address text, billing_state_code text,
  place_of_supply text, shipping_name text, shipping_contact text,
  shipping_gstin text, shipping_address text, shipping_state_code text,
  client_type text default 'B2B',
  is_deleted boolean default false,
  created_at timestamptz default now()
);
-- Recipients
create table if not exists recipients (
  id text primary key, name text,
  is_deleted boolean default false,
  created_at timestamptz default now()
);
-- Expenses
create table if not exists expenses (
  id text primary key, date text, paid_by text, amount numeric default 0,
  category text, comment text,
  is_deleted boolean default false,
  created_at timestamptz default now()
);
-- Payments
create table if not exists payments (
  id text primary key, order_id text, date text, amount numeric default 0,
  mode text, received_by text, txn_ref text, comments text,
  created_at timestamptz default now()
);
-- Assets
create table if not exists assets (
  id text primary key, name text, category text, purchase_date text,
  amount numeric default 0, paid_by text, vendor text, description text,
  invoice_url text, invoice_public_id text,
  linked_expense_id text,
  is_deleted boolean default false,
  created_at timestamptz default now()
);
-- Settings
create table if not exists settings (
  key text primary key, value text,
  created_at timestamptz default now()
);`;

// ─── Quotation HTML Builder ──────────────────────────────────────────────────
function buildQuotationHtml(orderArg, inv, sellerArg) {
  const seller = inv.sellerSnapshot || sellerArg;
  const order = inv.orderSnapshot ? {...orderArg, ...inv.orderSnapshot} : orderArg;
  const items = inv.items || [];
  const tG = items.reduce((s,i)=>s+num(i.grossAmt),0);
  const tC = items.reduce((s,i)=>s+num(i.cgstAmt),0);
  const tS = items.reduce((s,i)=>s+num(i.sgstAmt),0);
  const tN = items.reduce((s,i)=>s+num(i.netAmt),0);
  const ng = order.needsGst;
  const isIgst = ng && seller.stateCode && order.billingStateCode && String(order.billingStateCode).trim() !== String(seller.stateCode).trim();
  const cols = ng ? (isIgst ? 10 : 12) : 8;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${inv.invNo}</title>
<style>
  *{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#1a1a1a;margin:0;padding:24px;background:#fff}
  .page{max-width:900px;margin:0 auto}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #000;padding-bottom:14px;margin-bottom:14px}
  .co-name{font-size:19px;font-weight:800;color:#000;margin:4px 0 2px}.sd{font-size:11px;color:#333;line-height:1.6}
  .inv-title{font-size:17px;font-weight:800;color:#000;letter-spacing:1px;text-align:right}
  .inv-meta{font-size:11px;margin-top:6px;line-height:1.9;text-align:right}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}
  .box{border:1px solid #999;border-radius:5px;padding:9px 11px;font-size:11px;line-height:1.7}
  .bt{font-size:10px;font-weight:700;text-transform:uppercase;color:#555;margin-bottom:4px}
  table{width:100%;border-collapse:collapse;margin:10px 0;font-size:11px}
  th{background:#000;color:#fff;padding:7px 8px;text-align:center;font-weight:600;white-space:nowrap}
  td{padding:5px 8px;border-bottom:1px solid #ccc;text-align:center}
  .sr td{background:#eee;font-weight:600}.gr td{background:#000;color:#fff;font-weight:700;font-size:13px}
  .foot{margin-top:16px;display:flex;justify-content:space-between;align-items:flex-end;font-size:10px;color:#555;border-top:1px solid #ccc;padding-top:8px}
  .sig-block{text-align:center;font-size:10px;color:#333}
  .validity{margin-top:12px;padding:10px 12px;background:#f5f5f5;border:1px solid #ccc;border-radius:5px;font-size:11px;color:#000}
  @media print{body{padding:8px}}
</style></head><body><div class="page">
<div class="hdr">
  <div>${seller.logo?`<img src="${seller.logo}" style="max-height:60px;max-width:160px;object-fit:contain;margin-bottom:6px;display:block"/>`:""}<div class="co-name">${seller.name}</div>
    <div class="sd">${seller.address}<br>GSTIN: <b>${seller.gstin}</b> | State: ${seller.state} (${seller.stateCode})<br>${seller.phone}</div>
  </div>
  <div><div class="inv-title">QUOTATION</div>
    <div class="inv-meta"><b>Quotation #:</b> ${inv.invNo}<br><b>Date:</b> ${inv.invDate}<br><b>Order #:</b> ${order.orderNo}<br>${order.placeOfSupply?`<b>Place of Supply:</b> ${order.placeOfSupply}<br>`:""}</div>
  </div>
</div>
<div class="two-col">
  <div class="box"><div class="bt">Bill To${isIgst?" · <span style='color:#555;font-weight:normal'>Inter-State Supply</span>":""}</div><b>${order.billingName||order.customerName}</b><br>${order.billingAddress||""}<br>${order.type==="B2B"?`GSTIN: ${order.gstin||"-"}<br>State Code: ${order.billingStateCode||"-"}<br>`:""}${order.phone||order.contact||""}</div>
  <div class="box"><div class="bt">Ship To</div><b>${order.shippingName||order.billingName||order.customerName}</b><br>${order.shippingAddress||order.billingAddress||""}<br>${order.type==="B2B"?`GSTIN: ${order.shippingGstin||order.gstin||"-"}<br>State Code: ${order.shippingStateCode||order.billingStateCode||"-"}<br>`:""} ${order.shippingContact?`${order.shippingContact}<br>`:""}</div>
</div>
<table><thead><tr>
  <th>#</th><th>Item / Description</th><th>HSN</th>
  <th>Unit Price</th><th>Qty</th><th>Disc%</th><th>Gross</th>
  ${ng?(isIgst?`<th>IGST%</th><th>IGST</th>`:`<th>CGST%</th><th>CGST</th><th>SGST%</th><th>SGST</th>`):""}
  <th>Net Amount</th>
</tr></thead><tbody>
${items.map((it,i)=>`<tr><td>${i+1}</td><td>${it.item}</td><td>${it.hsn||"-"}</td>
  <td>₹${fmt(it.unitPrice)}</td><td>${it.qty}</td><td>${it.discount||0}%</td><td>₹${fmt(it.grossAmt)}</td>
  ${ng?(isIgst?`<td>${it.cgstRate+it.sgstRate}%</td><td>₹${fmt(it.cgstAmt+it.sgstAmt)}</td>`:`<td>${it.cgstRate}%</td><td>₹${fmt(it.cgstAmt)}</td><td>${it.sgstRate}%</td><td>₹${fmt(it.sgstAmt)}</td>`):""}
  <td><b>₹${fmt(it.netAmt)}</b></td></tr>`).join("")}
</tbody><tfoot>
  <tr class="sr"><td colspan="${ng?6:6}" style="text-align:right">Subtotals</td><td>₹${fmt(tG)}</td>${ng?(isIgst?`<td></td><td>₹${fmt(tC+tS)}</td>`:`<td></td><td>₹${fmt(tC)}</td><td></td><td>₹${fmt(tS)}</td>`):""}<td>₹${fmt(tN)}</td></tr>
  <tr class="gr"><td colspan="${cols-1}" style="text-align:right">GRAND TOTAL</td><td>₹${fmt(tN)}</td></tr>
</tfoot></table>
${inv.notes?`<div style="font-size:11px;color:#555;margin:8px 0"><b>Notes:</b> ${inv.notes}</div>`:""}
<div class="validity">This is a quotation only and not a tax invoice. Prices are valid for 15 days from the date of issue.</div>
</div></body></html>`;
}

// ─── Invoice HTML Builder ─────────────────────────────────────────────────────
function buildInvoiceHtml(orderArg, inv, type, sellerArg) {
  const seller = inv.sellerSnapshot || sellerArg;
  const order = inv.orderSnapshot ? {...orderArg, ...inv.orderSnapshot} : orderArg;
  const isProforma = type === "proforma";
  const title = isProforma ? "PROFORMA INVOICE" : "TAX INVOICE";
  const items = inv.items || [];
  const tG = items.reduce((s,i)=>s+num(i.grossAmt),0);
  const tC = items.reduce((s,i)=>s+num(i.cgstAmt),0);
  const tS = items.reduce((s,i)=>s+num(i.sgstAmt),0);
  const tN = items.reduce((s,i)=>s+num(i.netAmt),0);
  const ng = order.needsGst;
  const isIgst = ng && seller.stateCode && order.billingStateCode && String(order.billingStateCode).trim() !== String(seller.stateCode).trim();
  const cols = ng ? (isIgst ? 10 : 12) : 8;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${inv.invNo}</title>
<style>
  *{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#1a1a1a;margin:0;padding:24px;background:#fff}
  .page{max-width:900px;margin:0 auto}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #000;padding-bottom:14px;margin-bottom:14px}
  .co-name{font-size:19px;font-weight:800;color:#000;margin:4px 0 2px}.sd{font-size:11px;color:#333;line-height:1.6}
  .inv-title{font-size:17px;font-weight:800;color:#000;letter-spacing:1px;text-align:right}
  .inv-meta{font-size:11px;margin-top:6px;line-height:1.9;text-align:right}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}
  .box{border:1px solid #999;border-radius:5px;padding:9px 11px;font-size:11px;line-height:1.7}
  .bt{font-size:10px;font-weight:700;text-transform:uppercase;color:#555;margin-bottom:4px}
  table{width:100%;border-collapse:collapse;margin:10px 0;font-size:11px}
  th{background:#000;color:#fff;padding:7px 8px;text-align:center;font-weight:600;white-space:nowrap}
  td{padding:5px 8px;border-bottom:1px solid #ccc;text-align:center}
  .sr td{background:#eee;font-weight:600}.gr td{background:#000;color:#fff;font-weight:700;font-size:13px}
  .bank{margin-top:14px;padding:10px 12px;background:#f5f5f5;border:1px solid #ccc;border-radius:5px;font-size:11px;line-height:1.8}
  .foot{margin-top:16px;display:flex;justify-content:space-between;align-items:flex-end;font-size:10px;color:#555;border-top:1px solid #ccc;padding-top:8px}
  .sig-block{text-align:center;font-size:10px;color:#333}
  @media print{body{padding:8px}}
</style></head><body><div class="page">
<div class="hdr">
  <div>${seller.logo?`<img src="${seller.logo}" style="max-height:60px;max-width:160px;object-fit:contain;margin-bottom:6px;display:block"/>`:""}<div class="co-name">${seller.name}</div>
    <div class="sd">${seller.address}<br>GSTIN: <b>${seller.gstin}</b> | State: ${seller.state} (${seller.stateCode})<br>${seller.phone}</div>
  </div>
  <div><div class="inv-title">${title}</div>
    <div class="inv-meta"><b>Invoice #:</b> ${inv.invNo}<br><b>Date:</b> ${inv.invDate}<br><b>Order #:</b> ${order.orderNo}<br>${order.placeOfSupply?`<b>Place of Supply:</b> ${order.placeOfSupply}<br>`:""}</div>
  </div>
</div>
<div class="two-col">
  <div class="box"><div class="bt">Bill To${isIgst?" · <span style='color:#555;font-weight:normal'>Inter-State Supply</span>":""}</div><b>${order.billingName||order.customerName}</b><br>${order.billingAddress||""}<br>${order.type==="B2B"?`GSTIN: ${order.gstin||"-"}<br>State Code: ${order.billingStateCode||"-"}<br>`:""}${order.phone||order.contact||""}</div>
  <div class="box"><div class="bt">Ship To</div><b>${order.shippingName||order.billingName||order.customerName}</b><br>${order.shippingAddress||order.billingAddress||""}<br>${order.type==="B2B"?`GSTIN: ${order.shippingGstin||order.gstin||"-"}<br>State Code: ${order.shippingStateCode||order.billingStateCode||"-"}<br>`:""} ${order.shippingContact?`${order.shippingContact}<br>`:""}</div>
</div>
<table><thead><tr>
  <th>#</th><th>Item / Description</th><th>HSN</th>
  <th>Unit Price</th><th>Qty</th><th>Disc%</th><th>Gross</th>
  ${ng?(isIgst?`<th>IGST%</th><th>IGST</th>`:`<th>CGST%</th><th>CGST</th><th>SGST%</th><th>SGST</th>`):""}
  <th>Net Amount</th>
</tr></thead><tbody>
${items.map((it,i)=>`<tr><td>${i+1}</td><td>${it.item}</td><td>${it.hsn||"-"}</td>
  <td>₹${fmt(it.unitPrice)}</td><td>${it.qty}</td><td>${it.discount||0}%</td><td>₹${fmt(it.grossAmt)}</td>
  ${ng?(isIgst?`<td>${it.cgstRate+it.sgstRate}%</td><td>₹${fmt(it.cgstAmt+it.sgstAmt)}</td>`:`<td>${it.cgstRate}%</td><td>₹${fmt(it.cgstAmt)}</td><td>${it.sgstRate}%</td><td>₹${fmt(it.sgstAmt)}</td>`):""}
  <td><b>₹${fmt(it.netAmt)}</b></td></tr>`).join("")}
</tbody><tfoot>
  <tr class="sr"><td colspan="${ng?6:6}" style="text-align:right">Subtotals</td><td>₹${fmt(tG)}</td>${ng?(isIgst?`<td></td><td>₹${fmt(tC+tS)}</td>`:`<td></td><td>₹${fmt(tC)}</td><td></td><td>₹${fmt(tS)}</td>`):""}<td>₹${fmt(tN)}</td></tr>
  ${(inv.charges||[]).filter(c=>c.label&&Number(c.amount)).map(c=>`<tr><td colspan="${cols-1}" style="text-align:right;font-style:italic;color:#555">${c.label}</td><td>₹${fmt(Number(c.amount))}</td></tr>`).join("")}
  <tr class="gr"><td colspan="${cols-1}" style="text-align:right">GRAND TOTAL</td><td>₹${fmt(tN+(inv.charges||[]).reduce((s,c)=>s+Number(c.amount||0),0))}</td></tr>
</tfoot></table>

${inv.notes?`<div style="font-size:11px;color:#555;margin:8px 0"><b>Notes:</b> ${inv.notes}</div>`:""}
${!isProforma?`<div class="bank"><b>Bank Details:</b> ${seller.bank} | A/C No: ${seller.accountNo} | IFSC: ${seller.ifsc}</div>`:""}
${(isProforma&&seller.pfTerms)||(!isProforma&&seller.tiTerms)?`<div style="margin-top:12px;padding:10px 12px;background:#f9f9f9;border:1px solid #eee;border-radius:5px;font-size:10px;color:#444;line-height:1.8"><b style="font-size:11px">Terms & Conditions</b><br>${isProforma?(seller.pfTerms||"").replace(/\n/g,"<br>"):(seller.tiTerms||"").replace(/\n/g,"<br>")}</div>`:""}
${isProforma?'<div style="margin-top:8px;font-size:10px;color:#555;text-align:left">This is a Proforma Invoice and not a Tax Invoice.</div>':''}<div class="foot"><span></span>${seller.signatory?'<div class="sig-block"><img src="'+seller.signatory+'" style="max-height:70px;max-width:180px;object-fit:contain;display:block;margin:0 auto 4px"/><div>Authorised Signatory</div></div>':'<div class="sig-block"><div style="height:50px;border-bottom:1px solid #999;width:160px;margin:0 auto"></div><div style="margin-top:4px">Authorised Signatory</div></div>'}</div>
</div></body></html>`;
}

function printOrOpen(html) {
  const win = window.open("", "_blank");
  if (win) {
    win.document.open();
    win.document.write(html);
    win.document.close();
  } else {
    // Fallback if popup blocked — download as file
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

function downloadHtml(html, filename) {
  // Inject auto-print script so browser PDF dialog opens immediately
  const printHtml = html.replace("</body>", `<script>window.onload=function(){window.print();}<\/script></body>`);
  const win = window.open("", "_blank");
  if (win) {
    win.document.open();
    win.document.write(printHtml);
    win.document.close();
  } else {
    const blob = new Blob([printHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = (filename||"invoice") + ".html"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

// ─── Reusable UI ──────────────────────────────────────────────────────────────
function Badge({ label }) {
  const c = { B2B:"bg-blue-100 text-blue-800", B2C:"bg-emerald-100 text-emerald-800", "No GST":"bg-orange-100 text-orange-700", Pending:"bg-yellow-100 text-yellow-800", Completed:"bg-green-100 text-green-800", Cancelled:"bg-red-100 text-red-700" };
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${c[label]||"bg-gray-100 text-gray-600"}`}>{label}</span>;
}

function F({ label, value, onChange, type="text", required, className="", placeholder, disabled, rows }) {
  const b = "border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 w-full " + (disabled ? "bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed select-none" : "bg-white border-gray-200");
  return (
    <div className={`flex flex-col gap-1 ${className} ${disabled ? "relative" : ""}`}>
      {label && <label className={"text-xs font-semibold uppercase tracking-wide " + (disabled ? "text-gray-300" : "text-gray-500")}>{label}{required && <span className="text-red-400 ml-0.5">*</span>}</label>}
      <div className="relative">
        {rows
          ? <textarea value={value} onChange={e=>onChange(e.target.value)} rows={rows} placeholder={placeholder} disabled={disabled} className={b+" resize-none"}/>
          : <input type={type} value={value} onChange={e=>{ const v=e.target.value; if(type==="number"&&v!==""&&parseFloat(v)<0) return; onChange(v); }} placeholder={placeholder} disabled={disabled} className={b} {...(type==="number"?{onWheel:e=>e.target.blur(),inputMode:"decimal",min:"0"}:{})}/>
        }
        {disabled && <div className="absolute inset-0 rounded-lg bg-gray-200 opacity-30 pointer-events-none"/>}
      </div>
    </div>
  );
}

function S({ label, value, onChange, options, className="" }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {label && <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</label>}
      <select value={value} onChange={e=>onChange(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
        {options.map(o=><option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}
      </select>
    </div>
  );
}

// ─── Item Table ───────────────────────────────────────────────────────────────
function ItemTable({ items, setItems, needsGst, isIgst=false, products=[], seller={}, inventory=[], orders=[], wastageLog=[], currentOrderNo="" }) {
  const upd = (i,f,v) => setItems(items.map((it,idx)=>idx===i?calcItem({...it,[f]:v},needsGst):it));
  const add = () => setItems([...items, {...EMPTY_ITEM, sl:items.length+1}]);
  const del = (i) => setItems(items.filter((_,idx)=>idx!==i).map((it,idx)=>({...it,sl:idx+1})));
  const tG=items.reduce((s,i)=>s+num(i.grossAmt),0), tC=items.reduce((s,i)=>s+num(i.cgstAmt),0), tS=items.reduce((s,i)=>s+num(i.sgstAmt),0), tN=items.reduce((s,i)=>s+num(i.netAmt),0);
  const filamentPrices = seller.filamentPrices || {};

  // Compute used-per-spool to know which spools are still full/available
  const spoolUsed = {};
  orders.forEach(o => {
    if (o.orderNo===currentOrderNo) return; // exclude current order
    (o.filamentUsage||[]).forEach(u => { spoolUsed[u.inventoryId]=(spoolUsed[u.inventoryId]||0)+Number(u.weightUsedG||0); });
  });
  wastageLog.forEach(w => {
    // spread wastage across spools of matching group, largest-first (approx)
    const groupSpools = inventory.filter(i=>`${i.brand||""}||${i.material}||${i.color||""}`===w.groupKey).sort((a,b)=>Number(b.weightG)-Number(a.weightG));
    let rem=Number(w.weightG||0);
    for(const s of groupSpools){ const take=Math.min(rem,Math.max(0,Number(s.weightG||0)-(spoolUsed[s.id]||0))); spoolUsed[s.id]=(spoolUsed[s.id]||0)+take; rem-=take; if(rem<=0)break; }
  });
  // Full spools: remaining >= 95% of original weight (i.e. essentially untouched)
  const fullSpools = inventory.filter(i => {
    const remaining = Math.max(0, Number(i.weightG||0) - (spoolUsed[i.id]||0));
    return remaining >= Number(i.weightG||0) * 0.95 && Number(i.weightG||0) > 0;
  });
  // Group full spools by brand+material+color for the picker display
  const spoolGroups = {};
  fullSpools.forEach(s => {
    const key = `${s.brand||""}||${s.material}||${s.color||""}`;
    if (!spoolGroups[key]) spoolGroups[key] = { brand:s.brand, material:s.material, color:s.color, weightG:s.weightG, costTotal:s.costTotal, count:0 };
    spoolGroups[key].count++;
  });
  const spoolOptions = Object.values(spoolGroups);

  const applySpoolToRow = (rowIdx, sg) => {
    const name = [`${sg.brand||""}`, sg.material, sg.color, `${(Number(sg.weightG)/1000).toFixed(sg.weightG%1000===0?0:2)}kg`].filter(Boolean).join(' ');
    const unitPrice = sg.costTotal ? Math.round((Number(sg.costTotal)/1)*100)/100 : "";
    setItems(items.map((it,idx)=>idx===rowIdx ? calcItem({...it, item:name, unit:"Nos", unitPrice, qty:1, _brand:sg.brand, _material:sg.material, _spoolGroup:true}, needsGst) : it));
  };
  const getUnitPrice = (p) => {
    if (p.productType==="other") return p.unitPrice||"";
    const key = `${p.brand||""}||${p.material||""}`;
    const ppg = filamentPrices[key] || filamentPrices[`||${p.material||""}`] || 0;
    return ppg && p.weightG ? Math.round(Number(ppg)*Number(p.weightG)*100)/100 : p.unitPrice||"";
  };
  const applyProduct = (rowIdx, prod) => {
    const up = getUnitPrice(prod);
    const newItem = calcItem({
      ...items[rowIdx],
      item: prod.name,
      hsn: prod.hsn||"",
      unit: "Nos",
      unitPrice: up,
      cgstRate: prod.cgstRate||9,
      sgstRate: prod.sgstRate||9,
      _brand: prod.brand||"",
      _material: prod.material||"",
      _productId: prod.id,
    }, needsGst);
    setItems(items.map((it,idx)=>idx===rowIdx?newItem:it));
  };
  const FILAMENT_MATS = ["PLA","PETG","ABS","ASA","TPU","Nylon","PC","PLA+","PLA-CF","PETG-CF","ABS-CF","Resin",...Object.keys(filamentPrices).map(k=>k.split("||")[1]).filter(Boolean)].filter((v,i,a)=>a.indexOf(v)===i);
  const calcFromGrams = (rowIdx, brand, material, weightG) => {
    const key = `${brand||""}||${material||""}`;
    const ppg = filamentPrices[key] || filamentPrices[`||${material||""}`] || 0;
    if (!ppg || !weightG) return;
    const price = Math.round(Number(ppg)*Number(weightG)*100)/100;
    setItems(items.map((it,idx)=>idx===rowIdx?calcItem({...it,unitPrice:price,_brand:brand,_material:material},needsGst):it));
  };
  const inp = "border-0 bg-transparent focus:outline-none focus:bg-indigo-50 rounded px-1 w-full";
  const hdrs = ["#","Item / Description","HSN","Unit","Unit Price","Qty","Disc%",...(needsGst?(isIgst?["IGST%"]:["CGST%","SGST%"]):[]),"Gross",...(needsGst?(isIgst?["IGST"]:["CGST","SGST"]):[]),"Net Amt",""];
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100">
      <table className="w-full text-xs border-collapse" style={{minWidth:needsGst?(isIgst?"880px":"1020px"):"680px"}}>
        <thead><tr className="bg-slate-800 text-white">{hdrs.map((h,i)=><th key={i} className="px-2 py-2.5 text-center font-semibold whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>
          {items.map((it,i)=>(
            <tr key={i} className="border-b border-gray-100 hover:bg-slate-50">
              <td className="px-2 py-1.5 text-gray-400 w-6 text-center">{it.sl}</td>
              <td className="px-2 py-1.5">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1">
                    <input value={it.item} onChange={e=>upd(i,"item",e.target.value)} placeholder="Item name" className={inp+" min-w-[140px]"}/>
                    {products.length>0&&<select onChange={e=>{ if(e.target.value){ const p=products.find(p=>p.id===e.target.value); if(p) applyProduct(i,p); e.target.value=""; }}} className="border-0 bg-transparent text-xs text-indigo-500 focus:outline-none cursor-pointer" title="Fill from product">
                      <option value="">+ Product</option>
                      {products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>}
                    {spoolOptions.length>0&&<select onChange={e=>{ if(e.target.value){ const sg=spoolOptions[Number(e.target.value)]; if(sg) applySpoolToRow(i,sg); e.target.value=""; }}} className="border-0 bg-transparent text-xs text-orange-500 focus:outline-none cursor-pointer" title="Add full spool from inventory">
                      <option value="">+ Spool</option>
                      {spoolOptions.map((sg,si)=><option key={si} value={si}>{[sg.brand,sg.material,sg.color].filter(Boolean).join(' ')} {(Number(sg.weightG)/1000).toFixed(Number(sg.weightG)%1000===0?0:2)}kg ×{sg.count}</option>)}
                    </select>}
                  </div>
                  {(it._brand||it._material)&&<span className="text-[10px] text-gray-400">{[it._brand,it._material].filter(Boolean).join(" · ")}</span>}
                </div>
              </td>
              <td className="px-2 py-1.5 text-center"><input value={it.hsn} onChange={e=>upd(i,"hsn",e.target.value)} placeholder="HSN" className={inp+" w-16 text-center"}/></td>
              <td className="px-2 py-1.5 text-center"><select value={it.unit} onChange={e=>upd(i,"unit",e.target.value)} className="border-0 bg-transparent text-xs focus:outline-none text-center">{["Nos","g","ml","cm","Sqft","Box","Set","Pair"].map(u=><option key={u}>{u}</option>)}</select></td>
              <td className="px-2 py-1.5 text-center relative">
                <div className="flex items-center gap-0.5 justify-center">
                  <input type="number" value={it.unitPrice} onChange={e=>{if(e.target.value!==""&&parseFloat(e.target.value)<0)return;upd(i,"unitPrice",e.target.value);}} onWheel={e=>e.target.blur()} inputMode="decimal" min="0" className={inp+" w-16 text-center"}/>
                  <button type="button" title="Calculate from filament weight"
                    onClick={()=>setItems(items.map((it2,idx)=>idx===i?{...it2,_calcOpen:!it2._calcOpen,_calcBrand:it2._brand||"",_calcMat:it2._material||FILAMENT_MATS[0]||"PLA",_calcG:""}:it2))}
                    className="text-indigo-400 hover:text-indigo-600 font-semibold leading-none px-1 shrink-0" style={{fontSize:"10px"}}>g→₹</button>
                </div>
                {it._calcOpen&&(
                  <div className="absolute z-20 mt-1 bg-white border border-indigo-200 rounded-xl shadow-lg p-2 space-y-1.5" style={{minWidth:"200px"}}>
                    <p className="text-[10px] font-bold text-indigo-600 uppercase tracking-wide">Calc from weight</p>
                    <input value={it._calcBrand||""} onChange={e=>setItems(items.map((it2,idx)=>idx===i?{...it2,_calcBrand:e.target.value}:it2))}
                      placeholder="Brand (optional)" className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"/>
                    <select value={it._calcMat||"PLA"} onChange={e=>setItems(items.map((it2,idx)=>idx===i?{...it2,_calcMat:e.target.value}:it2))}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400">
                      {FILAMENT_MATS.map(m=><option key={m}>{m}</option>)}
                    </select>
                    <input type="number" value={it._calcG||""} onChange={e=>setItems(items.map((it2,idx)=>idx===i?{...it2,_calcG:e.target.value}:it2))}
                      onWheel={e=>e.target.blur()} placeholder="Weight (g)" className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"/>
                    {(()=>{
                      const key=`${it._calcBrand||""}||${it._calcMat||""}`;
                      const ppg=filamentPrices[key]||filamentPrices[`||${it._calcMat||""}`]||0;
                      const preview=ppg&&it._calcG?Math.round(Number(ppg)*Number(it._calcG)*100)/100:null;
                      return preview!==null?<p className="text-xs font-bold text-emerald-600">= ₹{preview}</p>:<p className="text-xs text-gray-400">{ppg?'Enter weight':'No price set for this material'}</p>;
                    })()}
                    <div className="flex gap-1 pt-0.5">
                      <button type="button" onClick={()=>{ calcFromGrams(i,it._calcBrand||"",it._calcMat||"PLA",it._calcG); setItems(prev=>prev.map((it2,idx)=>idx===i?{...it2,_calcOpen:false}:it2)); }}
                        className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded px-2 py-1 text-xs font-semibold">Apply</button>
                      <button type="button" onClick={()=>setItems(items.map((it2,idx)=>idx===i?{...it2,_calcOpen:false}:it2))}
                        className="border border-gray-200 text-gray-500 rounded px-2 py-1 text-xs">✕</button>
                    </div>
                  </div>
                )}
              </td>
              <td className="px-2 py-1.5 text-center"><input type="number" value={it.qty} onChange={e=>{if(e.target.value!==""&&parseFloat(e.target.value)<0)return;upd(i,"qty",e.target.value);}} onWheel={e=>e.target.blur()} inputMode="decimal" min="0" className={inp+" w-14 text-center"}/></td>
              <td className="px-2 py-1.5 text-center"><input type="number" value={it.discount} onChange={e=>{if(e.target.value!==""&&parseFloat(e.target.value)<0)return;upd(i,"discount",e.target.value);}} onWheel={e=>e.target.blur()} inputMode="decimal" min="0" className={inp+" w-12 text-center"}/></td>
              {needsGst&&(isIgst
                ? <td className="px-2 py-1.5 text-center text-xs text-gray-500">{Number(it.cgstRate)+Number(it.sgstRate)}%</td>
                : <><td className="px-2 py-1.5 text-center"><input type="number" value={it.cgstRate} onChange={e=>{if(e.target.value!==""&&parseFloat(e.target.value)<0)return;upd(i,"cgstRate",e.target.value);}} onWheel={e=>e.target.blur()} inputMode="decimal" min="0" max="100" placeholder="%" className="border-0 bg-transparent text-xs focus:outline-none w-12 text-center focus:bg-indigo-50 rounded"/></td>
                  <td className="px-2 py-1.5 text-center"><input type="number" value={it.sgstRate} onChange={e=>{if(e.target.value!==""&&parseFloat(e.target.value)<0)return;upd(i,"sgstRate",e.target.value);}} onWheel={e=>e.target.blur()} inputMode="decimal" min="0" max="100" placeholder="%" className="border-0 bg-transparent text-xs focus:outline-none w-12 text-center focus:bg-indigo-50 rounded"/></td></>)}
              <td className="px-2 py-1.5 text-center text-gray-600">₹{fmt(it.grossAmt)}</td>
              {needsGst&&(isIgst
                ? <td className="px-2 py-1.5 text-center text-gray-500">₹{fmt(num(it.cgstAmt)+num(it.sgstAmt))}</td>
                : <><td className="px-2 py-1.5 text-center text-gray-500">₹{fmt(it.cgstAmt)}</td><td className="px-2 py-1.5 text-center text-gray-500">₹{fmt(it.sgstAmt)}</td></>)}
              <td className="px-2 py-1.5 text-center font-bold text-slate-800">₹{fmt(it.netAmt)}</td>
              <td className="px-2 py-1.5"><button onClick={()=>del(i)} className="text-red-400 hover:text-red-600 font-bold px-1 text-base leading-none">×</button></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-slate-50 font-semibold">
            <td colSpan={needsGst?(isIgst?8:9):7} className="px-2 py-2 text-right text-gray-400 text-xs">Totals →</td>
            <td className="px-2 py-2 text-right text-xs">₹{fmt(tG)}</td>
            {needsGst&&(isIgst
              ? <td className="px-2 py-2 text-right text-xs">₹{fmt(tC+tS)}</td>
              : <><td className="px-2 py-2 text-right text-xs">₹{fmt(tC)}</td><td className="px-2 py-2 text-right text-xs">₹{fmt(tS)}</td></>)}
            <td className="px-2 py-2 text-right text-sm font-bold text-slate-800">₹{fmt(tN)}</td>
            <td/>
          </tr>
        </tfoot>
      </table>
      <button onClick={add} className="m-3 text-xs text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-1"><span className="text-base font-bold">+</span> Add Item</button>
    </div>
  );
}

// ─── Client Search Dropdown ───────────────────────────────────────────────────
function ClientSearch({ clients, onSelect, value }) {
  const [query, setQuery] = useState(value||"");
  const [open, setOpen] = useState(false);
  const ref = useRef();

  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(query.toLowerCase()) ||
    c.id.toLowerCase().includes(query.toLowerCase()) ||
    (c.gstin||"").toLowerCase().includes(query.toLowerCase())
  ).slice(0, 8);

  const handleSelect = (c) => { setQuery(c.name + " (" + c.id + ")"); setOpen(false); onSelect(c); };
  const handleClear = () => { setQuery(""); setOpen(false); onSelect(null); };

  return (
    <div className="relative flex flex-col gap-1" ref={ref}>
      <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Select Client <span className="normal-case text-gray-300 font-normal">(type to search)</span></label>
      <div className="flex gap-2">
        <input value={query} onChange={e=>{setQuery(e.target.value);setOpen(true);}} onFocus={()=>setOpen(true)} onBlur={()=>setTimeout(()=>setOpen(false),150)}
          placeholder="Search by name, client ID or GSTIN…"
          className="border border-indigo-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-indigo-50 w-full font-medium"/>
        {query && <button onClick={handleClear} className="text-gray-400 hover:text-red-500 text-lg px-1 font-bold leading-none">×</button>}
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 bg-white border border-gray-200 rounded-xl shadow-xl mt-1 overflow-hidden">
          {filtered.map(c => (
            <button key={c.id} onMouseDown={()=>handleSelect(c)}
              className="w-full text-left px-4 py-3 hover:bg-indigo-50 border-b border-gray-50 last:border-0 transition-colors">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="font-semibold text-sm text-slate-800">{c.name}</span>
                  {c.gstin && <span className="text-xs text-gray-400 ml-2">GST: {c.gstin}</span>}
                </div>
                <span className="text-xs font-mono bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full shrink-0">{c.id}</span>
              </div>
              {c.billingAddress && <div className="text-xs text-gray-400 mt-0.5 truncate">{c.billingAddress}</div>}
            </button>
          ))}
        </div>
      )}
      {open && query.length > 0 && filtered.length === 0 && (
        <div className="absolute top-full left-0 right-0 z-50 bg-white border border-gray-200 rounded-xl shadow-xl mt-1 px-4 py-3 text-sm text-gray-400">
          No clients found. <span className="text-indigo-500 font-medium">Add them in the Clients tab.</span>
        </div>
      )}
    </div>
  );
}

// ─── Order Form ───────────────────────────────────────────────────────────────
function OrderForm({ orders, setOrders, quotations, setQuotations, proformas, setProformas, taxInvoices, setTaxInvoices, seller, series, clients, recipients=[], onViewOrder=()=>{}, toast=()=>{}, products=[] }) {
  const topRef = useRef(null);
  const [type,setType]=useState("B2B"); const [needsGst,setNeedsGst]=useState(true);
  const [customerName,setCustomerName]=useState(""); const [phone,setPhone]=useState(""); const [email,setEmail]=useState(""); const [gstin,setGstin]=useState("");
  const [billingName,setBillingName]=useState(""); const [billingAddress,setBillingAddress]=useState(""); const [billingStateCode,setBillingStateCode]=useState("");
  const [shippingName,setShippingName]=useState(""); const [shippingContact,setShippingContact]=useState(""); const [shippingAddress,setShippingAddress]=useState(""); const [shippingGstin,setShippingGstin]=useState(""); const [shippingStateCode,setShippingStateCode]=useState("");
  const [sameAsBilling,setSameAsBilling]=useState(false);
  const [placeOfSupply,setPlaceOfSupply]=useState(""); const [orderDate,setOrderDate]=useState(today()); const [dueDate,setDueDate]=useState(addDays(today(),30)); const [paymentMode,setPaymentMode]=useState("UPI"); const [advance,setAdvance]=useState(""); const [status,setStatus]=useState("Pending"); const [comments,setComments]=useState("");
  const [items,setItems]=useState([{...EMPTY_ITEM}]);
  const [advanceRecipient,setAdvanceRecipient]=useState("");
  const [advanceTxnRef,setAdvanceTxnRef]=useState("");
  const [saving,setSaving]=useState(false); const [msg,setMsg]=useState(""); const [msgErr,setMsgErr]=useState(false);
  const [selectedClient,setSelectedClient]=useState(null);
  const [lastOrder,setLastOrder]=useState(null);

  const applyClient = (c) => {
    if (!c) { setSelectedClient(null); setSameAsBilling(false); return; }
    setSameAsBilling(false);
    setSelectedClient(c);
    setCustomerName(c.name||"");
    setPhone(c.contact||"");
    setEmail(c.email||"");
    setGstin(c.gstin||"");
    setBillingName(c.billingName||c.name||"");
    setBillingAddress(c.billingAddress||"");
    setBillingStateCode(c.billingStateCode||"");
    setPlaceOfSupply(c.placeOfSupply||"");
    setShippingName(c.shippingName||"");
    setShippingContact(c.shippingContact||"");
    setShippingGstin(c.shippingGstin||"");
    setShippingAddress(c.shippingAddress||"");
    setShippingStateCode(c.shippingStateCode||"");
  };

  const notify = (t,err=false) => { if(err){setMsg(t);setMsgErr(true);setTimeout(()=>setMsg(""),4000);}else{toast(t);} };

  const handleSave = async () => {
    if (!customerName) { notify("Customer name is required",true); toast("Customer name is required","error"); return; }
    if (num(advance)>0 && !advanceRecipient) { notify("Please select who received the advance",true); toast("Select who received the advance","error"); return; }
    setSaving(true);
    const orderNoBase = [series.prefix, series.format==="YYYYMM"?yyyymm():series.format==="YYYY"?yyyy():series.format==="YYYYMMDD"?yyyymmdd():""].filter(Boolean).join("/");
    const orderNo = buildOrderNo(series, type, orders);
    // Generate quotation number
    const qtPeriod = series.qtFormat==="YYYYMM"?yyyymm():series.qtFormat==="YYYY"?yyyy():series.qtFormat==="YYYYMMDD"?yyyymmdd():"";
    const {invNo:qtNo, invNoBase:qtBase} = genInvNo(series.qtPrefix||"QT", qtPeriod, quotations, Number(series.qtDigits)||6);
    const order = { orderNo, orderNoBase, type, customerName, phone, email, contact: phone, gstin, billingName, billingAddress, billingStateCode, shippingName, shippingAddress, shippingContact, shippingGstin, shippingStateCode, placeOfSupply, orderDate, dueDate: dueDate||addDays(orderDate,30), paymentMode, advance, advanceRecipient, advanceTxnRef, status, comments, needsGst, items, quotationNo: qtNo, proformaIds:[], taxInvoiceIds:[], charges:[] };
    const qt = { invNo:qtNo, invNoBase:qtBase, invDate:orderDate, items:[...items.map(i=>({...i}))], notes:comments, orderId:orderNo, amount:items.reduce((s,i)=>s+num(i.netAmt),0), sellerSnapshot:{...seller}, orderSnapshot:{customerName,billingName,billingAddress,billingStateCode,gstin:gstin||"",phone:phone||"",shippingName,shippingAddress,shippingContact,shippingGstin,shippingStateCode,type,needsGst,placeOfSupply} };
    setOrders(p=>[...p,order]);
    setQuotations(p=>[...p,qt]);
    setLastOrder(order);
    reset();
    setSaving(false);
    setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}), 100);
  };

  const reset = () => {
    setSelectedClient(null); setCustomerName(""); setPhone(""); setEmail(""); setGstin(""); setBillingName(""); setBillingAddress(""); setBillingStateCode(""); setShippingName(""); setShippingContact(""); setShippingAddress(""); setShippingGstin(""); setShippingStateCode(""); setSameAsBilling(false); setPlaceOfSupply(""); setOrderDate(today()); setDueDate(addDays(today(),30)); setAdvance(""); setAdvanceRecipient(""); setAdvanceTxnRef(""); setStatus("Pending"); setComments(""); setNeedsGst(true); setType("B2B"); setItems([{...EMPTY_ITEM}]); setMsg("");
  };

  const previewNo = buildOrderNo(series, type, orders);

  return (
    <div className="space-y-6" ref={topRef}>
      {msgErr&&msg&&<div className="px-4 py-2 rounded-lg text-sm font-medium bg-red-50 border border-red-200 text-red-700">{msg}</div>}
      {lastOrder&&(
        <div className="bg-emerald-50 border border-emerald-300 rounded-2xl p-5 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="font-bold text-emerald-800 text-base">&#x2705; Order Created Successfully!</p>
            <p className="text-sm text-emerald-700 mt-0.5">Order <span className="font-mono font-bold">{lastOrder.orderNo}</span> for <span className="font-semibold">{lastOrder.customerName}</span> has been saved.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={()=>onViewOrder(lastOrder)} className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">View Order</button>
            <button onClick={()=>setLastOrder(null)} className="border border-emerald-300 text-emerald-700 hover:bg-emerald-100 px-4 py-2 rounded-lg text-sm">Dismiss</button>
          </div>
        </div>
      )}
      <div className="space-y-5">
          <div className="flex gap-3 items-center flex-wrap">
            <span className="text-sm font-semibold text-gray-600">Customer Type:</span>
            {["B2B","B2C"].map(t=>(
              <button key={t} onClick={()=>{const ng=t==="B2B";setType(t);setNeedsGst(ng);setItems(prev=>prev.map(it=>calcItem(it,ng)));setSelectedClient(null);} }
                className={`px-5 py-2 rounded-full text-sm font-semibold border-2 transition-all ${type===t?"bg-indigo-600 border-indigo-600 text-white":"border-gray-300 text-gray-500 hover:border-indigo-400"}`}>{t}</button>
            ))}
            {type==="B2C"&&<label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer ml-1"><input type="checkbox" checked={needsGst} onChange={e=>{const ng=e.target.checked;setNeedsGst(ng);setItems(prev=>prev.map(it=>calcItem(it,ng)));} } className="rounded"/> Wants GST Invoice</label>}
            <span className="ml-auto text-xs text-gray-400 bg-gray-50 border rounded-lg px-3 py-1.5 font-mono">Next: <b className="text-indigo-600">{previewNo}</b></span>
          </div>
          {(type==="B2B" ? clients.filter(c=>c.clientType!=="B2C") : clients.filter(c=>c.clientType==="B2C")).length > 0 && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
              <ClientSearch clients={clients.filter(c=>(c.clientType||"B2B")===(type==="B2B"?"B2B":"B2C"))} onSelect={applyClient} value={selectedClient?selectedClient.name+" ("+selectedClient.id+")":""}/>
              {selectedClient && <p className="text-xs text-indigo-500 mt-2 font-medium">✓ Client details auto-filled — edit below if needed for this order</p>}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <F label="Customer / Company Name" value={customerName} onChange={setCustomerName} required className="col-span-2 md:col-span-1"/>
            <F label="Phone" value={phone} onChange={setPhone} placeholder="+91 XXXXX XXXXX"/>
            <F label="Email" value={email} onChange={setEmail} placeholder="customer@email.com"/>
            {type==="B2B"&&<F label="GSTIN" value={gstin} onChange={setGstin} placeholder="29XXXXX0000X1ZX"/>}
            <F label="Order Date" type="date" value={orderDate} onChange={v=>{setOrderDate(v);setDueDate(addDays(v,30));}}/>
            <F label="Due Date" type="date" value={dueDate||addDays(orderDate,30)} onChange={setDueDate}/>
            <S label="Payment Mode" value={paymentMode} onChange={setPaymentMode} options={PAYMENT_MODES}/>
            <F label="Advance Paid (₹)" type="number" value={advance} onChange={setAdvance}/>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Received By{num(advance)>0&&<span className="text-red-400"> *</span>}</label>
              <select value={advanceRecipient} onChange={e=>setAdvanceRecipient(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                <option value="">— Select recipient —</option>
                <option value="__company__">{seller?.name||"Company"}</option>{recipients.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <F label="Txn / Ref No (optional)" value={advanceTxnRef} onChange={setAdvanceTxnRef} placeholder="UPI ref, cheque no…"/>
            <S label="Order Status" value={status} onChange={setStatus} options={STATUS_OPTIONS}/>
          </div>
          <div className="border-t pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Billing Address</p>
            <div className="grid grid-cols-2 gap-4">
              <F label="Name on Invoice" value={billingName} onChange={setBillingName} placeholder={customerName}/>
              <F label="State/UT Code" value={billingStateCode} onChange={setBillingStateCode} placeholder="e.g. 29"/>
              <F label="Billing Address" value={billingAddress} onChange={setBillingAddress} rows={2} className="col-span-2"/>
            </div>
          </div>
          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700">Shipping Address</p>
              <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                <input type="checkbox" checked={sameAsBilling} onChange={e=>{
                  const checked=e.target.checked;
                  setSameAsBilling(checked);
                  if(checked){
                    setShippingName(billingName||customerName||"");
                    setShippingContact(phone||"");
                    setShippingAddress(billingAddress||"");
                    setShippingGstin(gstin||"");
                    setShippingStateCode(billingStateCode||"");
                  } else {
                    setShippingName(""); setShippingContact(""); setShippingAddress(""); setShippingGstin(""); setShippingStateCode("");
                  }
                }} className="rounded accent-indigo-600 w-4 h-4"/>
                <span className="font-medium text-indigo-600">Same as billing</span>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <F label="Name" value={sameAsBilling ? (billingName||customerName) : shippingName} onChange={v=>{if(!sameAsBilling)setShippingName(v);}} disabled={sameAsBilling}/>
              <F label="Contact Number" value={sameAsBilling ? phone : shippingContact} onChange={v=>{if(!sameAsBilling)setShippingContact(v);}} disabled={sameAsBilling} placeholder="+91 XXXXX XXXXX"/>
              {type==="B2B"&&<F label="GSTIN (if different)" value={sameAsBilling ? gstin : shippingGstin} onChange={v=>{if(!sameAsBilling)setShippingGstin(v);}} disabled={sameAsBilling}/>}
              <F label="State/UT Code" value={sameAsBilling ? billingStateCode : shippingStateCode} onChange={v=>{if(!sameAsBilling)setShippingStateCode(v);}} disabled={sameAsBilling}/>
              <F label="Shipping Address" value={sameAsBilling ? billingAddress : shippingAddress} onChange={v=>{if(!sameAsBilling)setShippingAddress(v);}} disabled={sameAsBilling} rows={2} className="col-span-2"/>
            </div>
          </div>
          {needsGst&&<F label="Place of Supply" value={placeOfSupply} onChange={setPlaceOfSupply} placeholder="e.g. Karnataka (29)" className="w-64"/>}
          <div className="border-t pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Order Items</p>
            <p className="text-xs text-gray-400 mb-3">These items form the basis of the quotation and all future invoices.</p>
            <ItemTable items={items} setItems={setItems} needsGst={needsGst} isIgst={needsGst&&seller?.stateCode&&billingStateCode&&String(billingStateCode).trim()!==String(seller.stateCode).trim()} products={products} seller={seller}/>
          </div>
          <F label="Comments / Notes" value={comments} onChange={setComments} rows={2}/>
          <div className="flex gap-3 items-center pt-2 border-t">
            <button onClick={handleSave} disabled={saving} className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-lg font-semibold text-sm disabled:opacity-50 transition-all">{saving?"Saving…":"Save Order & Generate Quotation"}</button>
            <button onClick={reset} className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-4 py-2.5 rounded-lg text-sm">Clear</button>
            <span className="ml-auto text-xs text-gray-400 bg-gray-50 border rounded-lg px-3 py-1.5 font-mono">Next: <b className="text-indigo-600">{previewNo}</b></span>
          </div>
      </div>
    </div>
  );
}

// ─── Order Detail / Edit Drawer ───────────────────────────────────────────────

// ─── Filament Usage Tab ───────────────────────────────────────────────────────
function FilamentUsageTab({ filamentUsage=[], setFilamentUsage, inventory=[], newUsage, setNewUsage, onSave, toast=()=>{}, orders=[], currentOrderNo="", wastageLog=[], onAddWastage=()=>{} }) {
  const upd = (k,v) => setNewUsage(p=>({...p,[k]:v}));

  const matColors = {
    PLA:"bg-green-100 text-green-700", PETG:"bg-blue-100 text-blue-700",
    ABS:"bg-orange-100 text-orange-700", ASA:"bg-amber-100 text-amber-700",
    TPU:"bg-purple-100 text-purple-700", Nylon:"bg-cyan-100 text-cyan-700",
    PC:"bg-slate-100 text-slate-700", "PLA+":"bg-emerald-100 text-emerald-700",
    "PLA-CF":"bg-gray-100 text-gray-700","PETG-CF":"bg-indigo-100 text-indigo-700",
    "ABS-CF":"bg-red-100 text-red-700", Resin:"bg-pink-100 text-pink-700",
    Other:"bg-gray-100 text-gray-500",
  };

  const selectedItem = inventory.find(i=>i.id===newUsage.inventoryId);

  const handleAdd = () => {
    if (!newUsage.groupKey) { toast("Select a filament","error"); return; }
    if (!newUsage.weightUsedG || isNaN(Number(newUsage.weightUsedG)) || Number(newUsage.weightUsedG)<=0) { toast("Enter weight used","error"); return; }
    // Find all spools in this group, compute each one's remaining stock
    const need = Number(newUsage.weightUsedG);
    const groupSpools = inventory
      .filter(i=>{ const k=`${i.brand||""}||${i.material}||${i.color||""}`; return k===newUsage.groupKey; })
      .map(spool=>{
        const alreadyUsed = filamentUsage
          .filter(u=>u.inventoryId===spool.id)
          .reduce((s,u)=>s+Number(u.weightUsedG||0),0);
        const otherOrdersUsed = orders
          .filter(o=>o.orderNo!==currentOrderNo)
          .flatMap(o=>o.filamentUsage||[])
          .filter(u=>u.inventoryId===spool.id)
          .reduce((s,u)=>s+Number(u.weightUsedG||0),0);
        const spoolRemaining = Math.max(0, Number(spool.weightG||0) - alreadyUsed - otherOrdersUsed);
        return { ...spool, spoolRemaining };
      })
      .filter(s=>s.spoolRemaining>0);

    // Strategy: find the smallest single spool that can satisfy the full amount.
    // If none can, split across spools largest-first to minimise number of spools used.
    const newEntries = [];
    const batchKey = "BATCH-"+Date.now(); // unique per addition — allows independent deletion
    const spoolsThatFit = groupSpools.filter(s=>s.spoolRemaining>=need);
    if (spoolsThatFit.length>0) {
      // Pick smallest spool that fits (least waste)
      const best = spoolsThatFit.sort((a,b)=>a.spoolRemaining-b.spoolRemaining)[0];
      newEntries.push({
        id:"FU-"+Date.now()+"-"+best.id,
        inventoryId: best.id,
        weightUsedG: Math.round(need*10)/10,
        isWaste: newUsage.isWaste,
        notes: newUsage.notes||"",
        groupKey: newUsage.groupKey,
        batchKey,
      });
    } else {
      // No single spool fits — split, draining largest spools first
      let remaining = need;
      for (const spool of [...groupSpools].sort((a,b)=>b.spoolRemaining-a.spoolRemaining)) {
        if (remaining<=0) break;
        const take = Math.min(remaining, spool.spoolRemaining);
        newEntries.push({
          id:"FU-"+Date.now()+"-"+spool.id,
          inventoryId: spool.id,
          weightUsedG: Math.round(take*10)/10,
          isWaste: newUsage.isWaste,
          notes: newUsage.notes||"",
          groupKey: newUsage.groupKey,
          batchKey,
        });
        remaining -= take;
      }
      if (remaining>0.05) toast(`Only ${(need-remaining).toFixed(0)}g available across all spools — recorded what was available`,"error");
    }
    if (newEntries.length===0) { toast("No stock remaining in this filament group","error"); return; }
    const updated = [...filamentUsage, ...newEntries];
    setFilamentUsage(updated);
    // If marked as waste, also register in inventory wastage log
    if (newUsage.isWaste) {
      const parts = newUsage.groupKey.split("||");
      const totalWasteG = newEntries.reduce((s,e)=>s+Number(e.weightUsedG||0),0);
      onAddWastage({
        id:"WL-"+Date.now(),
        date: today(),
        brand: parts[0]||"",
        material: parts[1]||"",
        color: parts[2]||"",
        groupKey: newUsage.groupKey,
        weightG: totalWasteG,
        reason: "Order Waste",
        orderNo: currentOrderNo,
        notes: newUsage.notes||"",
      });
    }
    setNewUsage({groupKey:"", weightUsedG:"", isWaste:false, notes:""});
    onSave(updated);
    toast("Filament usage recorded");
  };

  const handleRemove = (removeId) => {
    // If the entry has a groupKey, remove all entries from that group that were added together
    // (identified by groupKey + same isWaste combo) — but only the batch: use the entry's own id for single removal
    const updated = filamentUsage.filter(u=>u.id!==removeId);
    setFilamentUsage(updated);
    onSave(updated);
  };

  const totalUsed = filamentUsage.filter(u=>!u.isWaste).reduce((s,u)=>s+Number(u.weightUsedG||0),0);
  const totalWaste = filamentUsage.filter(u=>u.isWaste).reduce((s,u)=>s+Number(u.weightUsedG||0),0);

  const resolveItem = (id) => inventory.find(i=>i.id===id);

  // Compute total used per spool: other orders from saved data, current order from live local state
  const usedPerSpool = {};
  orders.forEach(o => {
    if (o.orderNo === currentOrderNo) return; // current order handled separately below
    (o.filamentUsage||[]).forEach(u => {
      usedPerSpool[u.inventoryId] = (usedPerSpool[u.inventoryId]||0) + Number(u.weightUsedG||0);
    });
  });
  // Add current order's live (unsaved) filamentUsage
  filamentUsage.forEach(u => {
    usedPerSpool[u.inventoryId] = (usedPerSpool[u.inventoryId]||0) + Number(u.weightUsedG||0);
  });
  // Add wastage deductions — spread across spools largest-first same as inventory view
  const _wTmpRem = {};
  inventory.forEach(i=>{ _wTmpRem[i.id] = Number(i.weightG||0) - (usedPerSpool[i.id]||0); });
  wastageLog.forEach(w => {
    let wLeft = Number(w.weightG||0);
    const spools = inventory
      .filter(i=>`${i.brand||""}||${i.material}||${i.color||""}`===w.groupKey)
      .sort((a,b)=>(_wTmpRem[b.id]||0)-(_wTmpRem[a.id]||0));
    for (const s of spools) {
      if (wLeft<=0) break;
      const avail = Math.max(0, _wTmpRem[s.id]||0);
      const take = Math.min(wLeft, avail);
      usedPerSpool[s.id] = (usedPerSpool[s.id]||0) + take;
      _wTmpRem[s.id] = (_wTmpRem[s.id]||0) - take;
      wLeft -= take;
    }
  });
  const getRemainingG = (id) => {
    const item = inventory.find(i=>i.id===id);
    if (!item) return null;
    return Math.max(0, Number(item.weightG||0) - (usedPerSpool[id]||0));
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-bold text-slate-700">Filament Usage</p>
        <p className="text-xs text-gray-400">Log filament used and waste for this order.</p>
      </div>

      {/* Summary */}
      {filamentUsage.length>0&&(
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3">
            <p className="text-xs text-indigo-400 mb-0.5">Total Used</p>
            <p className="text-sm font-bold text-indigo-700">{totalUsed.toFixed(1)} g</p>
          </div>
          <div className="bg-orange-50 border border-orange-100 rounded-xl px-4 py-3">
            <p className="text-xs text-orange-400 mb-0.5">Waste</p>
            <p className="text-sm font-bold text-orange-600">{totalWaste.toFixed(1)} g</p>
          </div>
        </div>
      )}

      {/* Add entry form */}
      <div className="bg-slate-50 border border-slate-100 rounded-xl p-3 space-y-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Add Entry</p>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold text-gray-500">Filament</label>
          {(()=>{
            const groups = {};
            inventory.forEach(i=>{
              const key = `${i.brand||""}||${i.material}||${i.color||""}`;
              if (!groups[key]) groups[key] = { brand:i.brand, material:i.material, color:i.color, items:[], totalWeight:0, totalRemaining:0 };
              groups[key].items.push(i);
              groups[key].totalWeight += Number(i.weightG||0);
              const rem = getRemainingG(i.id)??0;
              groups[key].totalRemaining += rem;
              if (rem>0) groups[key].spoolsLeft = (groups[key].spoolsLeft||0)+1;
            });
            return (
              <div className="space-y-1.5">
                {Object.entries(groups).map(([key,g])=>{
                  const pct = g.totalWeight>0 ? Math.round(g.totalRemaining/g.totalWeight*100) : 100;
                  const barC = pct>50?"bg-emerald-400":pct>20?"bg-amber-400":"bg-red-400";
                  const textC = pct>50?"text-emerald-600":pct>20?"text-amber-500":"text-red-500";
                  const isSelected = newUsage.groupKey===key;
                  return (
                    <button key={key} type="button" onClick={()=>upd("groupKey", isSelected?"":key)}
                      className={`w-full text-left rounded-xl px-3 py-2.5 border transition-all ${isSelected?"border-indigo-400 bg-indigo-50 ring-1 ring-indigo-300":"border-gray-200 bg-white hover:border-indigo-200 hover:bg-slate-50"}`}>
                      <div className="flex items-center gap-2 justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold shrink-0 ${matColors[g.material]||"bg-gray-100 text-gray-600"}`}>{g.material}</span>
                          <span className="text-sm font-semibold text-slate-800 truncate">{g.brand||"No brand"}</span>
                          <span className="text-sm text-gray-400 truncate">— {g.color||"No colour"}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-xs font-bold ${textC}`}>{g.totalRemaining.toFixed(0)}g left</span>
                          {(g.spoolsLeft||0)>1&&<span className="text-xs text-gray-400">{g.spoolsLeft} spools left</span>}
                        </div>
                      </div>
                      <div className="mt-1.5 h-1 bg-gray-100 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${barC}`} style={{width:`${pct}%`}}/>
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">Weight Used (g)</label>
            <input type="number" value={newUsage.weightUsedG} min="0" step="0.1"
              onChange={e=>upd("weightUsedG",e.target.value)} onWheel={e=>e.target.blur()} placeholder="0.0"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">Notes</label>
            <input value={newUsage.notes} onChange={e=>upd("notes",e.target.value)} placeholder="Optional…"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={newUsage.isWaste} onChange={e=>upd("isWaste",e.target.checked)}
            className="w-4 h-4 rounded accent-orange-500"/>
          <span className="text-sm text-gray-600">Mark as waste / support material</span>
        </label>
        <button onClick={handleAdd} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">
          + Add
        </button>
      </div>

      {/* Usage list */}
      {filamentUsage.length===0&&(
        <p className="text-xs text-gray-400 text-center py-6">No filament usage logged yet.</p>
      )}
      {/* Wastage linked to this order */}
      {wastageLog.filter(w=>w.orderNo===currentOrderNo).length>0&&(
        <div className="space-y-2">
          <p className="text-xs font-semibold text-orange-500 uppercase tracking-wide">Linked Wastage</p>
          {wastageLog.filter(w=>w.orderNo===currentOrderNo).map(w=>(
            <div key={w.id} className="flex items-start gap-3 rounded-xl px-4 py-3 border border-orange-100 bg-orange-50/40">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs bg-orange-100 text-orange-600 font-bold px-2 py-0.5 rounded-full">{w.reason}</span>
                  <span className="text-sm font-semibold text-slate-700">{w.brand||"No brand"} · {w.material} · {w.color||"No colour"}</span>
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <span className="text-sm font-bold text-orange-600">{Number(w.weightG).toFixed(1)} g</span>
                  <span className="text-xs text-gray-400">{w.date}</span>
                  {w.notes&&<span className="text-xs text-gray-400 italic">{w.notes}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(()=>{
        // Group entries by batchKey (each addition = one card, even same filament twice)
        // Falls back to groupKey for old entries without batchKey, then to single
        const displayed = [];
        const seen = new Set();
        filamentUsage.forEach(u=>{
          const bk = u.batchKey || u.groupKey;
          if (bk) {
            if (seen.has(bk)) return;
            seen.add(bk);
            const grouped = filamentUsage.filter(x=>(x.batchKey||x.groupKey)===bk);
            const totalG = grouped.reduce((s,x)=>s+Number(x.weightUsedG||0),0);
            const firstItem = resolveItem(grouped[0].inventoryId);
            displayed.push({ type:"group", bk, gk:u.groupKey, entries:grouped, totalG, firstItem, isWaste:grouped[0].isWaste, notes:grouped[0].notes });
          } else {
            const item = resolveItem(u.inventoryId);
            displayed.push({ type:"single", entry:u, item, isWaste:u.isWaste, notes:u.notes });
          }
        });
        return (
          <div className="space-y-2">
            {displayed.map((d,di)=>{
              const isWaste = d.isWaste;
              const borderCls = isWaste?"border-orange-100 bg-orange-50/40":"border-gray-100 bg-white";
              if (d.type==="group") {
                const fi = d.firstItem;
                return (
                  <div key={d.bk} className={`rounded-xl px-4 py-3 border ${borderCls}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          {fi&&<span className={`px-2 py-0.5 rounded-full text-xs font-bold ${matColors[fi.material]||"bg-gray-100 text-gray-600"}`}>{fi.material}</span>}
                          <span className="text-sm font-semibold text-slate-700">{fi?`${fi.brand||"No brand"} — ${fi.color||"No colour"}`:"Unknown"}</span>
                          {isWaste&&<span className="text-xs bg-orange-100 text-orange-600 font-semibold px-2 py-0.5 rounded-full">Waste</span>}
                        </div>
                        <div className="flex items-center gap-3 mt-1 flex-wrap">
                          <span className="text-sm font-bold text-indigo-700">{d.totalG.toFixed(1)} g total</span>
                          {d.notes&&<span className="text-xs text-gray-400 italic">{d.notes}</span>}
                        </div>
                        {d.entries.length>1&&(
                          <div className="mt-1.5 space-y-0.5">
                            {d.entries.map(e=>{
                              const si=resolveItem(e.inventoryId);
                              return <p key={e.id} className="text-xs text-gray-400">{si?.purchaseDate||"?"} spool · {Number(e.weightUsedG).toFixed(1)}g</p>;
                            })}
                          </div>
                        )}
                      </div>
                      <button onClick={()=>{ const updated=filamentUsage.filter(u=>(u.batchKey||u.groupKey)!==d.bk); setFilamentUsage(updated); onSave(updated); }} className="text-red-400 hover:text-red-600 font-bold text-lg leading-none shrink-0">×</button>
                    </div>
                  </div>
                );
              } else {
                const {entry:u, item} = d;
                return (
                  <div key={u.id||di} className={`flex items-start justify-between gap-3 rounded-xl px-4 py-3 border ${borderCls}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {item
                          ? <><span className={`px-2 py-0.5 rounded-full text-xs font-bold ${matColors[item.material]||"bg-gray-100 text-gray-600"}`}>{item.material}</span>
                             <span className="text-sm font-semibold text-slate-700">{item.brand||"No brand"} — {item.color||"No colour"}</span></>
                          : <span className="text-xs text-gray-400 italic">Spool not found</span>
                        }
                        {isWaste&&<span className="text-xs bg-orange-100 text-orange-600 font-semibold px-2 py-0.5 rounded-full">Waste</span>}
                      </div>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        <span className="text-sm font-bold text-indigo-700">{Number(u.weightUsedG).toFixed(1)} g</span>
                        {u.notes&&<span className="text-xs text-gray-400 italic">{u.notes}</span>}
                      </div>
                    </div>
                    <button onClick={()=>handleRemove(u.id)} className="text-red-400 hover:text-red-600 font-bold text-lg leading-none shrink-0">×</button>
                  </div>
                );
              }
            })}
          </div>
        );
      })()}
    </div>
  );
}

function OrderEditDrawer({ order, quotations, proformas, taxInvoices, seller, series, onClose, onSaveOrder, onSaveInvoice, onCreateInvoice, onDeleteOrder=()=>{}, onDeleteInvoice=()=>{}, recipients=[], toast=()=>{}, inventory=[], orders=[], wastageLog=[], setWastageLog=()=>{}, products=[] }) {
  const [tab, setTab] = useState("details");
  const [o, setO] = useState({...order});
  const [creating, setCreating] = useState(null); // "proforma" | "tax"
  const [payments, setPayments] = useState(order.payments||[]);
  const [newPay, setNewPay] = useState({date:today(), amount:"", mode:"UPI", receivedBy:"", txnRef:"", comments:""});
  const [statusPrompt, setStatusPrompt] = useState(null); // {updated} waiting for user decision
  const [filamentUsage, setFilamentUsage] = useState((order.filamentUsage||[]).map(u=>({...u})));
  const [newUsage, setNewUsage] = useState({groupKey:"", weightUsedG:"", isWaste:false, notes:""});
  const [charges, setCharges] = useState((order.charges||[]).map(c=>({...c})));
  const addCharge = () => setCharges(p=>[...p,{label:"",amount:""}]);
  const updCharge = (i,k,v) => setCharges(p=>p.map((c,ci)=>ci===i?{...c,[k]:v}:c));
  const delCharge = (i) => setCharges(p=>p.filter((_,ci)=>ci!==i));

  // Keep payments in sync with parent order prop (so reopening shows saved payments)
  useEffect(() => { setPayments(order.payments||[]); }, [order.payments]);
  // Keep order fields in sync when parent updates (e.g. after save)
  useEffect(() => { setO(prev=>({...order, ...prev, payments: order.payments||[] })); }, [order.orderNo]);

  const upd = (k,v) => setO(p=>({...p,[k]:v}));
  const isIgst = o.needsGst && seller?.stateCode && o.billingStateCode && String(o.billingStateCode).trim() !== String(seller.stateCode).trim();
  const qt = quotations.find(q=>q.orderId===order.orderNo);
  // Local editable items
  const [orderItems, setOrderItems] = useState((order.items||[]).map(i=>({...i})));
  // Sync orderItems when order.items prop changes (e.g. after initial load from Supabase)
  const prevOrderNo = useRef(order.orderNo);
  useEffect(() => {
    if (prevOrderNo.current !== order.orderNo) {
      // Different order opened — re-init everything from prop
      setOrderItems((order.items||[]).map(i=>({...i})));
      setFilamentUsage((order.filamentUsage||[]).map(u=>({...u})));
      setCharges((order.charges||[]).map(c=>({...c})));
      prevOrderNo.current = order.orderNo;
    }
    // Do NOT sync filamentUsage here on prop updates — it would overwrite
    // live local edits before onSave completes
  }, [order.orderNo]);
  const pfs = proformas.filter(p=>p.orderId===order.orderNo);
  const tis = taxInvoices.filter(t=>t.orderId===order.orderNo);

  const handleSaveOrder = (updatedFilamentUsage) => {
    const fu = updatedFilamentUsage !== undefined ? updatedFilamentUsage : filamentUsage;
    const updated = {...o, items: orderItems, filamentUsage: fu, charges};
    const origItems = JSON.stringify((order.items||[]).map(i=>({item:i.item,qty:i.qty,unitPrice:i.unitPrice})));
    const newItems  = JSON.stringify((orderItems||[]).map(i=>({item:i.item,qty:i.qty,unitPrice:i.unitPrice})));
    const itemsChanged = origItems !== newItems;
    if (itemsChanged && order.status === "Completed") {
      setStatusPrompt(updated);
      return;
    }
    onSaveOrder(updated);
    toast("Order changes saved");
  };
  const handleSaveInv = (updatedInv, type) => {
    // Preserve the original sellerSnapshot — never overwrite with current seller
    const origInv = type==="proforma"
      ? proformas.find(p=>p.invNo===updatedInv.invNo)
      : taxInvoices.find(t=>t.invNo===updatedInv.invNo);
    const saved = {...updatedInv, amount:updatedInv.items.reduce((s,i)=>s+num(i.netAmt),0), sellerSnapshot: updatedInv.sellerSnapshot || origInv?.sellerSnapshot, orderSnapshot: updatedInv.orderSnapshot || origInv?.orderSnapshot};
    onSaveInvoice(saved, type);
  };
  const handleCreate = (type) => setCreating(type);

  const totalPaid = payments.reduce((s,p)=>s+num(p.amount),0) + num(o.advance);
  const handleAddPayment = () => {
    if (!newPay.amount || isNaN(num(newPay.amount))) { toast("Enter a valid payment amount","error"); return; }
    if (!newPay.receivedBy) { toast("Select who received this payment","error"); return; }
    const entry = {...newPay, id: String(Date.now()), orderId: order.orderNo};
    const updated = [...payments, entry];
    setPayments(updated);
    // Save payment directly via prop and also persist to order
    onSaveOrder({...o, items: orderItems, payments: updated});
    setNewPay({date:today(), amount:"", mode:"UPI", receivedBy:"", txnRef:"", comments:""});
    toast("Payment added");
  };
  const handleDeletePayment = (id) => {
    const updated = payments.filter(p=>p.id!==id);
    setPayments(updated);
    onSaveOrder({...o, items: orderItems, payments: updated});
  };
  const handleSaveNew = (inv, type) => {
    const needsGstNow = type==="tax" && order.type==="B2C" && !order.needsGst ? true : undefined;
    const newInv = {...inv, orderId:order.orderNo, amount:inv.items.reduce((s,i)=>s+num(i.netAmt),0), sellerSnapshot:{...seller}, orderSnapshot:{customerName:order.customerName,billingName:order.billingName,billingAddress:order.billingAddress,billingStateCode:order.billingStateCode,gstin:order.gstin||"",phone:order.phone||order.contact||"",shippingName:order.shippingName,shippingAddress:order.shippingAddress,shippingContact:order.shippingContact,shippingGstin:order.shippingGstin,shippingStateCode:order.shippingStateCode,type:order.type,needsGst:order.needsGst,placeOfSupply:order.placeOfSupply}};
    onCreateInvoice(newInv, type, null, needsGstNow);
    if (needsGstNow) setO(p=>({...p, needsGst:true}));
    setCreating(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" onClick={onClose}/>
      {/* Drawer */}
      <div className="w-full max-w-2xl bg-white shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b bg-slate-800 text-white shrink-0">
          <div>
            <p className="font-mono text-sm text-slate-300">{order.orderNo}</p>
            <p className="font-bold text-lg leading-tight">{order.customerName}</p>
          </div>
          <button onClick={onClose} className="text-slate-300 hover:text-white text-2xl font-bold leading-none px-1">×</button>
        </div>

        {/* Status change modal */}
      {statusPrompt && (
        <div className="absolute inset-0 z-50 bg-black/50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full space-y-4">
            <h3 className="font-bold text-slate-800 text-base">Update Order Status?</h3>
            <p className="text-sm text-gray-600">You changed items on a <span className="font-semibold text-emerald-700">Completed</span> order. Would you like to move it back to <span className="font-semibold text-yellow-700">Pending</span>?</p>
            <div className="flex flex-col gap-2 pt-1">
              <button onClick={()=>{ const u={...statusPrompt,status:"Pending"}; onSaveOrder(u); setO(p=>({...p,status:"Pending"})); toast("Order saved — status moved to Pending"); setStatusPrompt(null); }}
                className="w-full py-2.5 rounded-xl bg-yellow-500 hover:bg-yellow-600 text-white font-semibold text-sm">
                Move to Pending
              </button>
              <button onClick={()=>{ onSaveOrder(statusPrompt); toast("Order changes saved"); setStatusPrompt(null); }}
                className="w-full py-2.5 rounded-xl border-2 border-gray-200 text-gray-700 hover:bg-gray-50 font-semibold text-sm">
                Keep as Completed
              </button>
              <button onClick={()=>setStatusPrompt(null)}
                className="text-xs text-gray-400 hover:text-gray-600 text-center pt-1">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
        <div className="flex border-b shrink-0 bg-gray-50">
          {[["details","Order"],["quotation","Quotation"],["invoices","Invoices"],["payments","Payments"],["filament","Filament"]].map(([id,label])=>(
            <button key={id} onClick={()=>{setTab(id);setCreating(null);}}
              className={`px-6 py-3 text-sm font-semibold border-b-2 transition-all ${tab===id?"border-indigo-600 text-indigo-700 bg-white":"border-transparent text-gray-500 hover:text-gray-700"}`}>
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">

          {tab==="details" && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <F label="Customer / Company Name" value={o.customerName} onChange={v=>upd("customerName",v)} className="col-span-2 md:col-span-1"/>
                <F label="Phone" value={o.phone||o.contact||""} onChange={v=>upd("phone",v)} placeholder="+91 XXXXX XXXXX"/>
                <F label="Email" value={o.email||""} onChange={v=>upd("email",v)} placeholder="customer@email.com"/>
                {o.type==="B2B"&&<F label="GSTIN" value={o.gstin||""} onChange={v=>upd("gstin",v)}/>}
                <F label="Order Date" type="date" value={o.orderDate} onChange={v=>upd("orderDate",v)}/>
                <F label="Due Date" type="date" value={o.dueDate||""} onChange={v=>upd("dueDate",v)}/>
                <S label="Payment Mode" value={o.paymentMode} onChange={v=>upd("paymentMode",v)} options={PAYMENT_MODES}/>
                <F label="Advance Paid (₹)" type="number" value={o.advance||""} onChange={v=>upd("advance",v)}/>
                <F label="Advance Txn Ref (optional)" value={o.advanceTxnRef||""} onChange={v=>upd("advanceTxnRef",v)} placeholder="UPI ref, cheque no…"/>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Advance Received By</label>
                  <select value={o.advanceRecipient||""} onChange={e=>upd("advanceRecipient",e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                    <option value="">— Select recipient —</option>
                    <option value="__company__">{seller?.name||"Company"}</option>{recipients.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
                <S label="Order Status" value={o.status} onChange={v=>upd("status",v)} options={STATUS_OPTIONS}/>
              </div>
              <div className="border-t pt-4">
                <p className="text-sm font-semibold text-gray-700 mb-3">Billing Address</p>
                <div className="grid grid-cols-2 gap-4">
                  <F label="Name on Invoice" value={o.billingName||""} onChange={v=>upd("billingName",v)}/>
                  <F label="State/UT Code" value={o.billingStateCode||""} onChange={v=>upd("billingStateCode",v)}/>
                  <F label="Billing Address" value={o.billingAddress||""} onChange={v=>upd("billingAddress",v)} rows={2} className="col-span-2"/>
                </div>
              </div>
              <div className="border-t pt-4">
                <p className="text-sm font-semibold text-gray-700 mb-3">Shipping Address</p>
                <div className="grid grid-cols-2 gap-4">
                  <F label="Name" value={o.shippingName||""} onChange={v=>upd("shippingName",v)}/>
                  <F label="Contact Number" value={o.shippingContact||""} onChange={v=>upd("shippingContact",v)}/>
                  {o.type==="B2B"&&<F label="GSTIN (if different)" value={o.shippingGstin||""} onChange={v=>upd("shippingGstin",v)}/>}
                  <F label="State/UT Code" value={o.shippingStateCode||""} onChange={v=>upd("shippingStateCode",v)}/>
                  <F label="Shipping Address" value={o.shippingAddress||""} onChange={v=>upd("shippingAddress",v)} rows={2} className="col-span-2"/>
                </div>
              </div>
              {o.needsGst&&<F label="Place of Supply" value={o.placeOfSupply||""} onChange={v=>upd("placeOfSupply",v)} className="w-64"/>}
              <F label="Comments / Notes" value={o.comments||""} onChange={v=>upd("comments",v)} rows={2}/>
              {/* Other Charges — saved on order, carried into Tax Invoice */}
              <div className="border-t pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-700">Other Charges <span className="text-xs font-normal text-gray-400">(shipping, handling — included in Tax Invoice)</span></p>
                  <button onClick={addCharge} className="text-xs text-indigo-600 border border-indigo-200 hover:bg-indigo-50 px-3 py-1 rounded-lg font-semibold">+ Add</button>
                </div>
                {charges.map((c,i)=>(
                  <div key={i} className="flex items-center gap-2">
                    <input value={c.label} onChange={e=>updCharge(i,"label",e.target.value)} placeholder="Label (e.g. Shipping)"
                      className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                    <span className="text-gray-400 text-sm shrink-0">₹</span>
                    <input type="number" value={c.amount} onChange={e=>updCharge(i,"amount",e.target.value)} onWheel={e=>e.target.blur()}
                      placeholder="0" className="w-24 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                    <button onClick={()=>delCharge(i)} className="text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>
                  </div>
                ))}
                {charges.length>0&&<p className="text-xs text-gray-400 text-right">Total: ₹{fmt(charges.reduce((s,c)=>s+Number(c.amount||0),0))}</p>}
              </div>

              <div className="border-t pt-4">
                <ExpandableItemTable items={orderItems} setItems={setOrderItems} needsGst={o.needsGst} isIgst={isIgst} products={products} seller={seller} inventory={inventory} orders={orders} wastageLog={wastageLog} currentOrderNo={order.orderNo} label="Order Items" sublabel="Edit items here to update quotation"/>
              </div>
              <div className="pt-3 border-t space-y-3">
                <button
                  onClick={()=>handleSaveOrder()}
                  className="relative w-full py-3 rounded-xl font-bold text-sm tracking-wide bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-sm hover:shadow-md hover:scale-[1.01] transition-all duration-200"
                >
                  Save Changes
                </button>
                <button
                  onClick={()=>{
                    if(window.confirm(`Delete order ${order.orderNo} for ${order.customerName}?\n\nThis will permanently delete the order and all its quotations, invoices and payments. This cannot be undone.`))
                      onDeleteOrder(order.orderNo);
                  }}
                  className="w-full py-3 rounded-xl font-bold text-sm tracking-wide border-2 border-red-200 text-red-500 hover:bg-red-50 hover:border-red-400 transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <span>🗑</span> Delete This Order
                </button>
              </div>
            </>
          )}

          {tab==="quotation" && (
            <div className="space-y-4">
              {qt
                ? <>
                    <div className="flex items-center justify-between">
                      <div><span className="font-mono font-bold text-sky-700">{qt.invNo}</span><span className="text-xs text-gray-400 ml-2">{qt.invDate}</span><span className="text-xs font-semibold text-sky-700 ml-3">₹{fmt(qt.amount)}</span></div>
                      <button onClick={()=>printOrOpen(buildQuotationHtml(o,qt,seller))} className="text-xs border border-sky-200 text-sky-700 hover:bg-sky-50 px-3 py-1.5 rounded-lg font-medium">👁 View</button><button onClick={()=>downloadHtml(buildQuotationHtml(o,qt,seller),qt.invNo)} className="text-xs border border-sky-200 text-sky-700 hover:bg-sky-50 px-3 py-1.5 rounded-lg font-medium">⬇ Download</button>
                    </div>
                    <div className="border-t pt-4">
                      <p className="text-xs text-gray-400 mb-2">Items in this quotation:</p>
                      <div className="opacity-70 select-none" onMouseDown={e=>e.preventDefault()}><ItemTable items={qt.items.map(i=>({...i}))} setItems={()=>{}} needsGst={order.needsGst} isIgst={isIgst}/></div>
                    </div>
                  </>
                : <p className="text-gray-400 text-sm text-center py-8">No quotation found for this order.</p>
              }
            </div>
          )}

          {tab==="invoices" && !creating && (
            <div className="space-y-4">
              <div className="flex gap-2 justify-end items-center flex-wrap">
                {order.type==="B2B"&&<button onClick={()=>handleCreate("proforma")} className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold">+ Proforma Invoice</button>}
                {(order.type==="B2B"||order.needsGst)
                  ? <button onClick={()=>handleCreate("tax")} className="text-xs bg-slate-700 hover:bg-slate-800 text-white px-4 py-2 rounded-lg font-semibold">+ Tax Invoice</button>
                  : <button onClick={()=>handleCreate("tax")} className="text-xs bg-slate-700 hover:bg-slate-800 text-white px-4 py-2 rounded-lg font-semibold">+ Tax Invoice (will enable GST)</button>
                }
              </div>
              {pfs.length===0&&tis.length===0&&<p className="text-gray-400 text-sm text-center py-6">No invoices yet. Create one above.</p>}
              {pfs.length>0&&(
                <div>
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Proforma Invoices</p>
                  <div className="space-y-2">
                    {pfs.map(p=>{
                      const tN=p.items.reduce((s,i)=>s+num(i.netAmt),0);
                      return (
                        <div key={p.invNo} className="flex items-center justify-between border border-blue-100 bg-blue-50 rounded-xl px-4 py-3 gap-3">
                          <div><span className="font-mono font-bold text-blue-800 text-sm">{p.invNo}</span><span className="text-xs text-blue-500 ml-2">{p.invDate}</span><span className="text-xs font-semibold text-blue-700 ml-3">₹{fmt(tN)}</span></div>
                          <div className="flex gap-2">
                            <button onClick={()=>onDeleteInvoice(p.invNo,"proforma")} className="text-xs border border-red-200 text-red-500 hover:bg-red-50 px-3 py-1.5 rounded-lg font-medium">Delete</button>
                            <button onClick={()=>printOrOpen(buildInvoiceHtml(o,p,"proforma",seller))} className="text-xs border border-blue-200 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-lg font-medium">👁 View</button><button onClick={()=>downloadHtml(buildInvoiceHtml(o,p,"proforma",seller),p.invNo)} className="text-xs border border-blue-200 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-lg font-medium">⬇ Download</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {tis.length>0&&(
                <div>
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Tax Invoices</p>
                  <div className="space-y-2">
                    {tis.map(t=>{
                      const tN=t.items.reduce((s,i)=>s+num(i.netAmt),0);
                      return (
                        <div key={t.invNo} className="flex items-center justify-between border border-slate-200 bg-slate-50 rounded-xl px-4 py-3 gap-3">
                          <div><span className="font-mono font-bold text-slate-800 text-sm">{t.invNo}</span><span className="text-xs text-slate-500 ml-2">{t.invDate}</span><span className="text-xs font-semibold text-slate-700 ml-3">₹{fmt(tN)}</span></div>
                          <div className="flex gap-2">
                            <button onClick={()=>onDeleteInvoice(t.invNo,"tax")} className="text-xs border border-red-200 text-red-500 hover:bg-red-50 px-3 py-1.5 rounded-lg font-medium">Delete</button>
                            <button onClick={()=>printOrOpen(buildInvoiceHtml(o,t,"tax",seller))} className="text-xs border border-slate-200 text-slate-600 hover:bg-slate-100 px-3 py-1.5 rounded-lg font-medium">👁 View</button><button onClick={()=>downloadHtml(buildInvoiceHtml(o,t,"tax",seller),t.invNo)} className="text-xs border border-slate-200 text-slate-600 hover:bg-slate-100 px-3 py-1.5 rounded-lg font-medium">⬇ Download</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab==="invoices" && creating && (
<div className="space-y-4">
              <InvoiceEditor
              inv={{ invNo:"(auto)", invDate:today(), items: order.items && order.items.length > 0 ? order.items.map(i=>({...i})) : [{...EMPTY_ITEM}], notes:"", charges: creating==="tax" ? (order.charges||[]).map(c=>({...c})) : [] }}
              type={creating}
              needsGst={creating==="tax" ? true : order.needsGst}
              isNew={true}
              series={series}
              existingList={creating==="proforma" ? proformas : taxInvoices}
              onSave={(inv)=>handleSaveNew(inv, creating)}
              onCancel={()=>setCreating(null)}
              isIgst={isIgst}
              products={products}
              seller={seller}
            /></div>
          )}



          {tab==="filament" && (
            <FilamentUsageTab
              filamentUsage={filamentUsage}
              setFilamentUsage={setFilamentUsage}
              inventory={inventory}
              newUsage={newUsage}
              setNewUsage={setNewUsage}
              onSave={handleSaveOrder}
              toast={toast}
              orders={orders}
              currentOrderNo={order.orderNo}
              wastageLog={wastageLog}
              onAddWastage={(w)=>setWastageLog(prev=>[...prev,w])}
            />
          )}

          {tab==="payments" && (() => {
            const tiTotal=tis.reduce((s,t)=>s+num(t.amount),0);
            const qt2=quotations.find(q=>q.orderId===order.orderNo);
            const qtTotal=qt2?num(qt2.amount):(order.items||[]).reduce((s,i)=>s+num(i.netAmt),0);
            const orderTotal=tiTotal>0?tiTotal:qtTotal;
            const balance=orderTotal-totalPaid;
            return (
              <div className="space-y-5">
                {/* Summary strip */}
                <div className="grid grid-cols-3 gap-3">
                  {[["Order Total","₹"+fmt(orderTotal),"text-slate-700"],["Total Paid","₹"+fmt(totalPaid),"text-emerald-600"],["Balance Due",balance>0?"₹"+fmt(balance):"Nil",balance>0?"text-orange-500":"text-gray-400"]].map(([label,val,cls])=>(
                    <div key={label} className="bg-gray-50 rounded-xl px-4 py-3 border border-gray-100">
                      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
                      <p className={`text-sm font-bold ${cls}`}>{val}</p>
                    </div>
                  ))}
                </div>

                {/* Add payment form */}
                <div className="border border-indigo-100 bg-indigo-50/40 rounded-xl p-4 space-y-3">
                  <p className="text-xs font-bold text-indigo-700 uppercase tracking-wide">Record Payment</p>
                  <div className="grid grid-cols-2 gap-3">
                    <F label="Date" type="date" value={newPay.date} onChange={v=>setNewPay(p=>({...p,date:v}))}/>
                    <F label="Amount (₹)" type="number" value={newPay.amount} onChange={v=>setNewPay(p=>({...p,amount:v}))} placeholder="0.00"/>
                    <S label="Payment Mode" value={newPay.mode} onChange={v=>setNewPay(p=>({...p,mode:v}))} options={PAYMENT_MODES}/>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Received By{num(o.advance)>0&&<span className="text-red-400"> *</span>}</label>
                      <select value={newPay.receivedBy} onChange={e=>setNewPay(p=>({...p,receivedBy:e.target.value}))} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                        <option value="">— Select recipient —</option>
                        <option value="__company__">{seller?.name||"Company"}</option>{recipients.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </div>
                    <F label="Txn / Ref No (optional)" value={newPay.txnRef} onChange={v=>setNewPay(p=>({...p,txnRef:v}))} placeholder="UPI ref, cheque no…"/>
                    <F label="Comments (optional)" value={newPay.comments} onChange={v=>setNewPay(p=>({...p,comments:v}))} placeholder="e.g. Part payment" className="col-span-2"/>
                  </div>
                  <button onClick={handleAddPayment} className="px-5 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white transition-all">
                    + Add Payment
                  </button>
                </div>

                {/* Payment history */}
                {num(o.advance)>0&&(()=>{
                  const advRcp=o.advanceRecipient==="__company__"?{name:seller?.name||"Company"}:(recipients.find(r=>r.id===o.advanceRecipient)||allRecipients.find(r=>r.id===o.advanceRecipient));
                  return (
                    <div className="border border-gray-100 rounded-xl px-4 py-3 bg-white">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-bold text-emerald-600">₹{fmt(o.advance)}</span>
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{o.paymentMode||"—"}</span>
                          <span className="text-xs text-gray-400">{o.orderDate}</span>
                          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Advance</span>
                        </div>
                      </div>
                      {advRcp&&<p className="text-xs text-indigo-500 mt-0.5">👤 {advRcp.name}</p>}
                      {o.advanceTxnRef&&<p className="text-xs text-gray-400 mt-0.5 font-mono">Ref: {o.advanceTxnRef}</p>}
                    </div>
                  );
                })()}
                {payments.length===0&&num(o.advance)===0&&(
                  <p className="text-gray-400 text-sm text-center py-6">No payments recorded yet.</p>
                )}
                <div className="space-y-2">
                  {payments.slice().reverse().map(p=>(
                    <div key={p.id} className="flex items-start justify-between border border-gray-100 rounded-xl px-4 py-3 bg-white gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-bold text-emerald-600">₹{fmt(p.amount)}</span>
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{p.mode}</span>
                          <span className="text-xs text-gray-400">{p.date}</span>
                        </div>
                        {p.receivedBy&&(()=>{const r=p.receivedBy==="__company__"?{name:seller?.name||"Company"}:(recipients.find(x=>x.id===p.receivedBy)||allRecipients.find(x=>x.id===p.receivedBy));return r?<p className="text-xs text-indigo-500 mt-0.5">👤 {r.name}</p>:null;})()}
                        {p.txnRef&&<p className="text-xs text-gray-400 mt-0.5 font-mono">Ref: {p.txnRef}</p>}
                        {p.comments&&<p className="text-xs text-gray-500 mt-0.5">{p.comments}</p>}
                      </div>
                      <button onClick={()=>handleDeletePayment(p.id)} className="text-red-300 hover:text-red-500 text-lg leading-none shrink-0 mt-0.5">×</button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

// ─── Invoice Editor ────────────────────────────────────────────────────────────

// ─── Expandable Item Table ────────────────────────────────────────────────────
function ExpandableItemTable({ items, setItems, needsGst, label, sublabel, isIgst=false, products=[], seller={}, inventory=[], orders=[], wastageLog=[], currentOrderNo="" }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [fsItems, setFsItems] = useState(null); // local copy for fullscreen edits
  const openFullscreen = () => { setFsItems(items.map(i=>({...i}))); setFullscreen(true); };
  const handleDone = () => { setItems(fsItems); setFullscreen(false); setFsItems(null); };
  const handleCancel = () => { setFullscreen(false); setFsItems(null); };
  return (
    <>
      <div className="space-y-2">
        <div className="space-y-0.5">
          <div className="flex items-center justify-between">
            {label && <p className="text-sm font-semibold text-gray-700">{label}</p>}
            <button onClick={openFullscreen} className="ml-auto flex items-center gap-1.5 text-xs font-semibold text-indigo-600 border border-indigo-200 hover:bg-indigo-50 px-3 py-1.5 rounded-lg transition-all">
              ⛶ Full Screen
            </button>
          </div>
          {sublabel && <p className="text-xs text-gray-400">{sublabel}</p>}
        </div>
        <ItemTable items={items} setItems={setItems} needsGst={needsGst} isIgst={isIgst} products={products} seller={seller} inventory={inventory} orders={orders} wastageLog={wastageLog} currentOrderNo={currentOrderNo}/>
      </div>
      {fullscreen && fsItems !== null && (
        <div className="fixed inset-0 z-[70] bg-white flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b bg-white shrink-0">
            <span className="font-bold text-slate-800">Items — Full Screen</span>
            <div className="flex gap-2">
              <button onClick={handleCancel} className="text-sm bg-red-500 hover:bg-red-600 text-white px-4 py-1.5 rounded-lg font-semibold">Cancel</button>
              <button onClick={handleDone} className="text-sm bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-1.5 rounded-lg font-semibold">Done</button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-6">
            <ItemTable items={fsItems} setItems={setFsItems} needsGst={needsGst} isIgst={isIgst} products={products} seller={seller} inventory={inventory} orders={orders} wastageLog={wastageLog} currentOrderNo={currentOrderNo}/>
          </div>
        </div>
      )}
    </>
  );
}

function InvoiceEditor({ inv, type, needsGst, onSave, onCancel, isNew, series, existingList, isIgst=false, products=[], seller={} }) {
  const prefix = isNew ? (type==="proforma"?(series?.pfPrefix||"PF"):(series?.tiPrefix||"TAX")) : null;
  const period = isNew ? (type==="proforma"?(series?.pfFormat==="YYYYMM"?yyyymm():series?.pfFormat==="YYYY"?yyyy():series?.pfFormat==="YYYYMMDD"?yyyymmdd():""):(series?.tiFormat==="YYYYMM"?yyyymm():series?.tiFormat==="YYYY"?yyyy():series?.tiFormat==="YYYYMMDD"?yyyymmdd():"")) : null;
  const { invNo:autoNo, invNoBase:autoBase } = isNew ? genInvNo(prefix, period, existingList||[], Number(series?.invDigits)||6) : { invNo: inv.invNo, invNoBase: inv.invNoBase };
  const [d, setD] = useState({...inv, items: inv.items.map(i=>({...i})), invNo: isNew ? autoNo : inv.invNo, invNoBase: isNew ? autoBase : inv.invNoBase, charges: inv.charges||[] });
  const upd = (k,v) => setD(p=>({...p,[k]:v}));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 text-sm flex items-center gap-1">← Back</button>
        <span className="font-mono font-bold text-slate-700">{d.invNo}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${type==="proforma"?"bg-blue-100 text-blue-700":"bg-slate-100 text-slate-700"}`}>{type==="proforma"?"Proforma":"Tax Invoice"}</span>
        {isNew&&<span className="text-xs text-emerald-600 font-medium">Items pre-filled from order — edit as needed</span>}
      </div>
      <F label="Invoice Date" type="date" value={d.invDate} onChange={v=>upd("invDate",v)} className="w-48"/>
      {isNew && type==="proforma"
        ? <ExpandableItemTable items={d.items} setItems={items=>setD(p=>({...p,items}))} needsGst={needsGst} isIgst={isIgst} products={products} seller={seller} label="Invoice Items"/>
        : (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-gray-700">Invoice Items <span className="text-xs font-normal text-gray-400 ml-1">{type==="tax" ? "(locked — tax invoice items cannot be changed)" : "(locked — delete and recreate to change items)"}</span></p>
            <div className="opacity-60 pointer-events-none select-none rounded-xl border border-gray-100 overflow-hidden">
              <ItemTable items={d.items} setItems={()=>{}} needsGst={needsGst} isIgst={isIgst}/>
            </div>
          </div>
        )
      }
      {(d.charges||[]).filter(c=>c.label&&Number(c.amount)).length>0&&(
        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 space-y-1">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Other Charges (from order)</p>
          {(d.charges||[]).filter(c=>c.label&&Number(c.amount)).map((c,i)=>(
            <div key={i} className="flex justify-between text-sm text-gray-700">
              <span>{c.label}</span><span className="font-semibold">₹{fmt(Number(c.amount))}</span>
            </div>
          ))}
          <div className="flex justify-between text-sm font-bold text-slate-800 border-t border-slate-200 pt-1 mt-1">
            <span>Total charges</span><span>₹{fmt((d.charges||[]).reduce((s,c)=>s+Number(c.amount||0),0))}</span>
          </div>
        </div>
      )}
      <F label="Notes" value={d.notes||""} onChange={v=>upd("notes",v)} rows={2}/>
      <div className="flex gap-3 pt-2 border-t">
        <button onClick={()=>{ onSave(d); }} className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-lg font-semibold text-sm">Save</button>
        <button onClick={onCancel} className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-4 py-2.5 rounded-lg text-sm">Cancel</button>
      </div>
    </div>
  );
}

// ─── Orders List ──────────────────────────────────────────────────────────────

// ─── Excel Export Utility ─────────────────────────────────────────────────────
async function loadSheetJs() {
  if (window.XLSX) return window.XLSX;
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => resolve(window.XLSX);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function exportToExcel(rows, filename) {
  if (!rows || rows.length === 0) return;
  const XLSX = await loadSheetJs();
  const ws = XLSX.utils.json_to_sheet(rows);
  // Auto column widths
  const cols = Object.keys(rows[0]);
  ws["!cols"] = cols.map(k => ({ wch: Math.max(k.length, ...rows.map(r => String(r[k]||"").length).slice(0,50)) + 2 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.writeFile(wb, filename + ".xlsx");
}

function ExcelBtn({ onClick }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-emerald-300 text-emerald-700 hover:bg-emerald-50 transition-all">
      ⬇ Export Excel
    </button>
  );
}

function OrdersList({ orders, setOrders, quotations, setQuotations, proformas, setProformas, taxInvoices, setTaxInvoices, seller, series, recipients=[], allRecipients=[], upsertPayment=()=>{}, enqueue=()=>{}, initialOrder=null, onClearInitialOrder=()=>{}, toast=()=>{}, inventory=[], wastageLog=[], setWastageLog=()=>{}, products=[] }) {
  const [search,setSearch]=useState("");
  const [filter,setFilter]=useState("All");
  const [typeFilter,setTypeFilter]=useState("All");
  const [balFilter,setBalFilter]=useState(false);
  const [openOrder,setOpenOrder]=useState(null);
  useEffect(()=>{ if(initialOrder){ setOpenOrder(initialOrder); onClearInitialOrder(); } },[initialOrder]);

  const getTotal = (o) => {
    const tiTotal=taxInvoices.filter(t=>t.orderId===o.orderNo).reduce((s,t)=>s+num(t.amount),0);
    const qt=quotations.find(q=>q.orderId===o.orderNo);
    const qtTotal=qt?num(qt.amount):(o.items||[]).reduce((s,i)=>s+num(i.netAmt),0);
    return tiTotal>0?tiTotal:qtTotal;
  };
  const getTotalPaid = (o) => num(o.advance) + (o.payments||[]).reduce((s,p)=>s+num(p.amount),0);

  const searched=orders.filter(o=>o.orderNo.toLowerCase().includes(search.toLowerCase())||o.customerName.toLowerCase().includes(search.toLowerCase()));
  const filtered=searched
    .filter(o=>filter==="All"||o.status===filter)
    .filter(o=>typeFilter==="All"||o.type===typeFilter)
    .filter(o=>!balFilter||(getTotal(o)-getTotalPaid(o))>0);

  // Sync order items + quotation whenever items change
  const syncItemsAndQuotation = (orderNo, mergedItems) => {
    if (!mergedItems) return;
    setOrders(prev => prev.map(o => o.orderNo===orderNo ? {...o, items:mergedItems} : o));
    setQuotations(prev => prev.map(q => q.orderId===orderNo
      ? {...q, items:mergedItems, amount:mergedItems.reduce((s,i)=>s+num(i.netAmt),0)}
      : q));
  };

  const handleDeleteOrder = (orderNo) => {
    setOrders(orders.filter(o=>o.orderNo!==orderNo));
    setQuotations(quotations.filter(q=>q.orderId!==orderNo));
    setProformas(proformas.filter(p=>p.orderId!==orderNo));
    setTaxInvoices(taxInvoices.filter(t=>t.orderId!==orderNo));
    enqueue({action:"delete",table:"orders",col:"order_no",val:orderNo});
    enqueue({action:"delete",table:"quotations",col:"order_id",val:orderNo});
    enqueue({action:"delete",table:"proformas",col:"order_id",val:orderNo});
    enqueue({action:"delete",table:"tax_invoices",col:"order_id",val:orderNo});
    enqueue({action:"deleteMany",table:"items",col:"document_id",val:orderNo});
    enqueue({action:"deleteMany",table:"payments",col:"order_id",val:orderNo});
    setOpenOrder(null);
  };

  const handleSaveOrder = (updated) => {
    const orderNo = updated.orderNo;
    const newItems = updated.items;
    setOrders(orders.map(o=>o.orderNo===orderNo?updated:o));
    // Sync all payments to Supabase
    if (updated.payments?.length) {
      updated.payments.forEach(p=>upsertPayment({...p, orderId:orderNo, id:String(p.id||Date.now())}));
    }
    // Sync items to quotation AND tax invoices
    if (newItems) {
      const updatedQt = quotations.find(q=>q.orderId===orderNo);
      if (updatedQt) {
        const newQt = {...updatedQt, items:newItems, amount:newItems.reduce((s,i)=>s+num(i.netAmt),0)};
        setQuotations(prev => prev.map(q => q.orderId===orderNo ? newQt : q));
      }
      // Proforma mirrors order items (like quotation)
      setProformas(prev => prev.map(p => {
        if (p.orderId !== orderNo) return p;
        return {...p, items:newItems, amount:newItems.reduce((s,i)=>s+num(i.netAmt),0)};
      }));
      // Tax invoices are independent documents — never auto-merge order items into them
    }
    setOpenOrder(updated);
  };

  const pushItemsToTaxInvoices = (orderNo, mergedItems) => {
    if (!mergedItems) return;
    setTaxInvoices(prev => prev.map(t => {
      if (t.orderId !== orderNo) return t;
      const merged = mergeItemsIntoOrder(t.items, mergedItems);
      return {...t, items: merged, amount: merged.reduce((s,i)=>s+num(i.netAmt),0)};
    }));
  };

  const [invStatusPrompt, setInvStatusPrompt] = useState(null); // {updatedInv, type, orderNo}

  const handleSaveInvoice = (updatedInv, type, mergedItems) => {
    const orderNo = openOrder?.orderNo;
    const orderObj = orders.find(o=>o.orderNo===orderNo);
    if (type==="tax" && orderObj?.status==="Completed") {
      const origInv = taxInvoices.find(t=>t.invNo===updatedInv.invNo);
      const origItems = JSON.stringify((origInv?.items||[]).map(i=>({item:i.item,qty:i.qty,unitPrice:i.unitPrice})));
      const newItems  = JSON.stringify((updatedInv.items||[]).map(i=>({item:i.item,qty:i.qty,unitPrice:i.unitPrice})));
      if (origItems !== newItems) {
        setInvStatusPrompt({updatedInv, type, orderNo});
        return;
      }
    }
    toast(type==="proforma"?"Proforma saved":"Tax invoice saved");
    const orderNo2 = orderNo;
    if(type==="proforma"){
      const orig = proformas.find(p=>p.invNo===updatedInv.invNo);
      const saved = {...updatedInv, sellerSnapshot: updatedInv.sellerSnapshot || orig?.sellerSnapshot, orderSnapshot: updatedInv.orderSnapshot || orig?.orderSnapshot};
      setProformas(proformas.map(p=>p.invNo===saved.invNo?saved:p));
    } else {
      const orig = taxInvoices.find(t=>t.invNo===updatedInv.invNo);
      const saved = {...updatedInv, sellerSnapshot: updatedInv.sellerSnapshot || orig?.sellerSnapshot, orderSnapshot: updatedInv.orderSnapshot || orig?.orderSnapshot};
      setTaxInvoices(taxInvoices.map(t=>t.invNo===saved.invNo?saved:t));
    }
  };

  const handleDeleteInvoice = (invNo, type) => {
    if (!window.confirm(`Delete ${type==="proforma"?"Proforma":"Tax Invoice"} ${invNo}?\n\nThis cannot be undone. You can recreate it after deletion.`)) return;
    const orderNo = openOrder?.orderNo;
    if (type==="proforma") {
      setProformas(prev => prev.filter(p => p.invNo !== invNo));
      setOrders(prev => {
        const updated = prev.map(o => o.orderNo===orderNo ? {...o, proformaIds:(o.proformaIds||[]).filter(id=>id!==invNo)} : o);
        const changedOrder = updated.find(o=>o.orderNo===orderNo);
        if (changedOrder) enqueue([{action:"upsert",table:"orders",row:{order_no:changedOrder.orderNo,proforma_ids:JSON.stringify(changedOrder.proformaIds||[])}}]);
        return updated;
      });
      enqueue({action:"delete", table:"proformas", col:"inv_no", val:invNo});
      enqueue({action:"deleteMany", table:"items", col:"document_id", val:invNo});
    } else {
      setTaxInvoices(prev => prev.filter(t => t.invNo !== invNo));
      setOrders(prev => {
        const updated = prev.map(o => o.orderNo===orderNo ? {...o, taxInvoiceIds:(o.taxInvoiceIds||[]).filter(id=>id!==invNo)} : o);
        const changedOrder = updated.find(o=>o.orderNo===orderNo);
        if (changedOrder) enqueue([{action:"upsert",table:"orders",row:{order_no:changedOrder.orderNo,tax_invoice_ids:JSON.stringify(changedOrder.taxInvoiceIds||[])}}]);
        return updated;
      });
      enqueue({action:"delete", table:"tax_invoices", col:"inv_no", val:invNo});
      enqueue({action:"deleteMany", table:"items", col:"document_id", val:invNo});
    }
    toast(`${type==="proforma"?"Proforma":"Tax Invoice"} ${invNo} deleted`);
  };

  const doSaveInvoiceWithStatus = (updatedInv, type, orderNo, newStatus) => {
    if (type==="proforma") {
      setProformas(proformas.map(p=>p.invNo===updatedInv.invNo?updatedInv:p));
    } else {
      setTaxInvoices(taxInvoices.map(t=>t.invNo===updatedInv.invNo?updatedInv:t));
    }
    if (newStatus) {
      setOrders(orders.map(o=>o.orderNo===orderNo?{...o,status:newStatus}:o));
    }
  };

  const handleCreateInvoice = (inv, type, mergedItems, needsGstFlip) => {
    const orderNo = openOrder.orderNo;
    const orderObj = orders.find(o=>o.orderNo===orderNo)||openOrder;
    if(type==="proforma"){
      setProformas(p=>[...p, inv]);
      setOrders(orders.map(o=>o.orderNo===orderNo?{...o,proformaIds:[...(o.proformaIds||[]),inv.invNo]}:o));
    } else {
      setTaxInvoices(p=>[...p, inv]);
      // For B2C: always flip needsGst to true when tax invoice is created
      const isB2C = orderObj.type==="B2C";
      setOrders(orders.map(o=>{
        if (o.orderNo!==orderNo) return o;
        return {...o, taxInvoiceIds:[...(o.taxInvoiceIds||[]),inv.invNo], ...(isB2C?{needsGst:true}:{})};
      }));
    }
  };

  const todayStr = today();

  const renderCard = (o) => {
    const pfs=proformas.filter(p=>p.orderId===o.orderNo), tis=taxInvoices.filter(t=>t.orderId===o.orderNo);
    const qt=quotations.find(q=>q.orderId===o.orderNo);
    // Total: use tax invoice total if exists, else quotation/order items total
    const tiTotal=tis.reduce((s,t)=>s+num(t.amount),0);
    const qtTotal=qt?num(qt.amount):(o.items||[]).reduce((s,i)=>s+num(i.netAmt),0);
    const tN=tiTotal>0?tiTotal:qtTotal;
    const bal=tN-getTotalPaid(o);
    const due=o.dueDate||"";
    const isOverdue=o.status==="Pending"&&due&&due<todayStr;
    const isDueSoon=o.status==="Pending"&&due&&due>=todayStr&&due<=addDays(todayStr,3);
    return (
      <div key={o.orderNo} onClick={()=>setOpenOrder(o)} className={`border rounded-xl px-4 py-3 hover:shadow-md transition-all bg-white cursor-pointer ${isOverdue?"border-red-200 bg-red-50/30":isDueSoon?"border-amber-200 bg-amber-50/30":"border-gray-100 hover:border-indigo-200"}`}>
        {/* Row 1: order no + badges + arrow */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <span className="font-bold text-slate-700 font-mono text-xs">{o.orderNo}</span>
            <Badge label={o.type}/>{o.type==="B2C"&&!o.needsGst&&!(taxInvoices.some(t=>t.orderId===o.orderNo))&&<Badge label="No GST"/>}<Badge label={o.status}/>
            {isOverdue&&<span className="text-xs font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded-full">⚠ Overdue</span>}
            {isDueSoon&&!isOverdue&&<span className="text-xs font-bold text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded-full">⏰ Due soon</span>}
          </div>
          <span className="text-gray-300 shrink-0">›</span>
        </div>
        {/* Row 2: customer + GSTIN */}
        <p className="text-sm font-bold text-gray-800 mt-1 leading-tight">{o.customerName}</p>
        {o.type==="B2B"&&o.gstin&&<p className="text-xs text-gray-400 font-mono">{o.gstin}</p>}
        {/* Row 3: data pills */}
        <div className="grid grid-cols-5 gap-0 mt-2 border border-gray-100 rounded-lg overflow-hidden">
          {[
            ["Order Date", o.orderDate||"—", "text-gray-600"],
            ["Due Date", due||"—", isOverdue?"text-red-600":isDueSoon?"text-amber-600":"text-gray-600"],
            ["Total", tN>0?`₹${fmt(tN)}`:"—", "text-gray-800"],
            ["Advance", num(o.advance)>0?`₹${fmt(o.advance)}`:"—", "text-emerald-600"],
            ["Balance Due", tN>0?(bal>0?`₹${fmt(bal)}`:"Nil"):"—", bal>0?"text-orange-500":"text-gray-400"],
          ].map(([lbl,val,cls],i)=>(
            <div key={i} className={`py-2 flex flex-col items-center justify-center ${i<4?"border-r border-gray-100":""}`}>
              <p className="leading-none mb-1 text-center text-gray-500 font-semibold uppercase tracking-wide" style={{fontSize:"9px"}}>{lbl}</p>
              <p className={`text-xs font-semibold text-center ${cls}`}>{val}</p>
            </div>
          ))}
        </div>
        {/* Row 4: print buttons */}
        <div className="flex gap-1.5 flex-wrap mt-2 pt-2 border-t border-gray-100" onClick={e=>e.stopPropagation()}>
          {qt&&<button onClick={()=>printOrOpen(buildQuotationHtml(o,qt,seller))} className="text-xs border border-sky-200 text-sky-700 hover:bg-sky-50 px-2.5 py-1 rounded-full font-mono">👁 {qt.invNo}</button>}
          {pfs.map(p=><button key={p.invNo} onClick={()=>printOrOpen(buildInvoiceHtml(o,p,"proforma",seller))} className="text-xs border border-blue-200 text-blue-600 hover:bg-blue-50 px-2.5 py-1 rounded-full font-mono">👁 {p.invNo}</button>)}
          {tis.map(t=><button key={t.invNo} onClick={()=>printOrOpen(buildInvoiceHtml(o,t,"tax",seller))} className="text-xs border border-slate-200 text-slate-700 hover:bg-slate-50 px-2.5 py-1 rounded-full font-mono">👁 {t.invNo}</button>)}
        </div>
      </div>
    );
  };

  const pendingOrders = filtered.filter(o=>o.status==="Pending").sort((a,b)=>{
    const da = a.dueDate||addDays(a.orderDate,30), db = b.dueDate||addDays(b.orderDate,30);
    return da < db ? -1 : da > db ? 1 : 0;
  });
  const completedOrders = filtered.filter(o=>o.status==="Completed").slice().reverse();
  const cancelledOrders = filtered.filter(o=>o.status==="Cancelled").slice().reverse();

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by order # or customer…" className="border border-gray-200 rounded-lg px-4 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 whitespace-nowrap">Order Status</span>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
              {["All","Pending","Completed","Cancelled"].map(f=>(
                <button key={f} onClick={()=>setFilter(f)} className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${filter===f?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700"}`}>{f}</button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 whitespace-nowrap">Customer Type</span>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
              {["All","B2B","B2C"].map(t=>(
                <button key={t} onClick={()=>setTypeFilter(t)} className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${typeFilter===t?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700"}`}>{t}</button>
              ))}
            </div>
          </div>
          <button onClick={()=>setBalFilter(v=>!v)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${balFilter?"bg-orange-500 border-orange-500 text-white":"border-gray-200 text-gray-500 hover:border-orange-400 hover:text-orange-500"}`}>
            Balance Due
          </button>
          <ExcelBtn onClick={()=>{
            const rows = filtered.map(o=>({
              "Order No": o.orderNo,
              "Type": o.type,
              "Customer": o.customerName,
              "GSTIN": o.gstin||"",
              "Order Date": o.orderDate||"",
              "Due Date": o.dueDate||"",
              "Status": o.status,
              "Total (₹)": getTotal(o),
              "Advance (₹)": num(o.advance),
              "Paid (₹)": getTotalPaid(o),
              "Balance (₹)": getTotal(o)-getTotalPaid(o),
              "Payment Mode": o.paymentMode||"",
              "Comments": o.comments||""
            }));
            exportToExcel(rows, "Orders_Export");
          }}/>
        </div>
      </div>
      {filtered.length===0&&<p className="text-gray-400 text-sm text-center py-12">{filter==="All"&&typeFilter==="All"?"No orders yet. Create your first order!":`No ${[typeFilter!=="All"?typeFilter:"",filter!=="All"?filter.toLowerCase():""].filter(Boolean).join(" ")} orders found.`}</p>}

      {pendingOrders.length>0&&(filter==="All"||filter==="Pending")&&(
        <div className="space-y-2">
          <div className="flex items-center gap-2"><span className="text-xs font-bold uppercase tracking-widest text-yellow-700">⏳ Pending</span><span className="text-xs text-gray-400">({pendingOrders.length}) · sorted by due date</span></div>
          <div className="space-y-3">{pendingOrders.map(renderCard)}</div>
        </div>
      )}

      {completedOrders.length>0&&(filter==="All"||filter==="Completed")&&(
        <div className="space-y-2">
          <div className="flex items-center gap-2"><span className="text-xs font-bold uppercase tracking-widest text-green-700">✅ Completed</span><span className="text-xs text-gray-400">({completedOrders.length})</span></div>
          <div className="space-y-3">{completedOrders.map(renderCard)}</div>
        </div>
      )}

      {cancelledOrders.length>0&&(filter==="All"||filter==="Cancelled")&&(
        <div className="space-y-2">
          <div className="flex items-center gap-2"><span className="text-xs font-bold uppercase tracking-widest text-red-600">✕ Cancelled</span><span className="text-xs text-gray-400">({cancelledOrders.length})</span></div>
          <div className="space-y-3">{cancelledOrders.map(renderCard)}</div>
        </div>
      )}

      {invStatusPrompt && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full space-y-4">
            <h3 className="font-bold text-slate-800 text-base">Update Order Status?</h3>
            <p className="text-sm text-gray-600">You changed items on a <span className="font-semibold text-emerald-700">Completed</span> order. Would you like to move it back to <span className="font-semibold text-yellow-700">Pending</span>?</p>
            <div className="flex flex-col gap-2 pt-1">
              <button onClick={()=>{ doSaveInvoiceWithStatus(invStatusPrompt.updatedInv, invStatusPrompt.type, invStatusPrompt.orderNo, "Pending"); toast("Invoice saved — order moved to Pending"); setInvStatusPrompt(null); }}
                className="w-full py-2.5 rounded-xl bg-yellow-500 hover:bg-yellow-600 text-white font-semibold text-sm">
                Move to Pending
              </button>
              <button onClick={()=>{ doSaveInvoiceWithStatus(invStatusPrompt.updatedInv, invStatusPrompt.type, invStatusPrompt.orderNo, null); toast(invStatusPrompt.type==="proforma"?"Proforma saved":"Tax invoice saved"); setInvStatusPrompt(null); }}
                className="w-full py-2.5 rounded-xl border-2 border-gray-200 text-gray-700 hover:bg-gray-50 font-semibold text-sm">
                Keep as Completed
              </button>
              <button onClick={()=>setInvStatusPrompt(null)}
                className="text-xs text-gray-400 hover:text-gray-600 text-center pt-1">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {openOrder && (
        <OrderEditDrawer
          order={orders.find(o=>o.orderNo===openOrder.orderNo)||openOrder}
          quotations={quotations}
          proformas={proformas}
          taxInvoices={taxInvoices}
          seller={seller}
          series={series}
          onClose={()=>setOpenOrder(null)}
          onSaveOrder={handleSaveOrder}
          onSaveInvoice={handleSaveInvoice}
          onCreateInvoice={handleCreateInvoice}
          onDeleteOrder={handleDeleteOrder}
          onDeleteInvoice={handleDeleteInvoice}
          toast={toast}
          recipients={recipients}
          inventory={inventory}
          orders={orders}
          wastageLog={wastageLog}
          setWastageLog={setWastageLog}
          products={products}
        />
      )}
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────
// ─── Product Manager ──────────────────────────────────────────────────────────
function ProductManager({ products=[], setProducts=()=>{}, seller={}, toast=()=>{}, inventory=[] }) {
  const EMPTY_P = { id:"", name:"", hsn:"", brand:"", material:"PLA", weightG:"", unitPrice:"", productType:"3d_printed", cgstRate:9, sgstRate:9, notes:"" };
  const [form, setForm] = useState({...EMPTY_P});
  const [editId, setEditId] = useState(null);
  const [search, setSearch] = useState("");
  const upd = (k,v) => setForm(p=>({...p,[k]:v}));

  const filamentPrices = seller.filamentPrices || {};
  const priceKey = (brand, material) => `${brand||""}||${material||""}`;
  const computedPrice = (brand, material, weightG) => {
    const ppg = filamentPrices[priceKey(brand, material)] || filamentPrices[priceKey("", material)] || 0;
    return ppg && weightG ? (Number(ppg) * Number(weightG)).toFixed(2) : "";
  };

  const baseMats = ["PLA","PETG","ABS","ASA","TPU","Nylon","PC","PLA+","PLA-CF","PETG-CF","ABS-CF","Resin"];
  const allMaterials = [...new Set([
    ...baseMats,
    ...products.map(p=>p.material).filter(m=>m&&!baseMats.includes(m)),
    ...inventory.map(i=>i.material).filter(m=>m&&!baseMats.includes(m)),
  ].filter(Boolean))];
  const allBrands = [...new Set(products.map(p=>p.brand).filter(Boolean))];

  const handleSave = () => {
    if (!form.name.trim()) { toast("Product name required","error"); return; }
    const entry = {
      ...form,
      id: editId || ("PROD-"+Date.now()),
      weightG: form.productType==="3d_printed" ? Number(form.weightG)||0 : 0,
      unitPrice: form.productType==="other" ? Number(form.unitPrice)||0 : 0,
      productType: form.productType||"3d_printed",
      cgstRate: Number(form.cgstRate)||9,
      sgstRate: Number(form.sgstRate)||9,
    };
    setProducts(prev => editId ? prev.map(p=>p.id===editId?entry:p) : [...prev,entry]);
    setForm({...EMPTY_P}); setEditId(null);
    toast(editId?"Product updated":"Product added");
  };
  const handleEdit = (p) => { setForm({...p, weightG:String(p.weightG||""), unitPrice:String(p.unitPrice||""), productType:p.productType||"3d_printed"}); setEditId(p.id); };
  const handleDelete = (id) => { if(window.confirm("Delete this product?")) setProducts(prev=>prev.filter(p=>p.id!==id)); };

  const filtered = products.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.brand.toLowerCase().includes(search.toLowerCase()) || p.material.toLowerCase().includes(search.toLowerCase())
  );

  const unitPrice = computedPrice(form.brand, form.material, form.weightG);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><p className="text-sm font-bold text-slate-700">Products</p><p className="text-xs text-gray-400">Define products — 3D printed (price from filament) or other items sold by the piece.</p></div>
      </div>

      {/* Form */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{editId?"Edit Product":"New Product"}</p>
        {/* Type toggle */}
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit mb-1">
          {[["3d_printed","🖨 3D Printed"],["other","📦 Other / Pcs"]].map(([v,l])=>(
            <button key={v} type="button" onClick={()=>upd("productType",v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${form.productType===v?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700"}`}>{l}</button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">Product Name</label>
            <input value={form.name} onChange={e=>upd("name",e.target.value)} placeholder={form.productType==="3d_printed"?"e.g. Phone Stand - Black PLA":"e.g. Packaging Box, Screws…"}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">HSN Code</label>
            <input value={form.hsn} onChange={e=>upd("hsn",e.target.value)} placeholder="e.g. 3926"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">Brand <span className="text-gray-400 font-normal">(optional)</span></label>
            <input value={form.brand} onChange={e=>upd("brand",e.target.value)} placeholder="e.g. Bambu, In-house…"
              list="prod-brands"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
            <datalist id="prod-brands">{allBrands.map(b=><option key={b} value={b}/>)}</datalist>
          </div>

          {form.productType==="3d_printed"&&<>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500">Material</label>
              <select value={form.material} onChange={e=>upd("material",e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                {allMaterials.map(m=><option key={m}>{m}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500">Weight Used (g)</label>
              <input type="number" value={form.weightG} min="0" step="0.1" onChange={e=>upd("weightG",e.target.value)} onWheel={e=>e.target.blur()}
                placeholder="0.0"
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500">Calculated Unit Price</label>
              <div className={`border rounded-lg px-3 py-2 text-sm font-semibold ${unitPrice?"border-emerald-300 bg-emerald-50 text-emerald-700":"border-gray-200 bg-gray-50 text-gray-400"}`}>
                {unitPrice ? `₹${unitPrice}` : "— set filament price in Inventory tab"}
              </div>
            </div>
          </>}

          {form.productType==="other"&&(
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500">Unit Price (₹)</label>
              <input type="number" value={form.unitPrice} min="0" step="0.01" onChange={e=>upd("unitPrice",e.target.value)} onWheel={e=>e.target.blur()}
                placeholder="0.00"
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">CGST %</label>
            <input type="number" value={form.cgstRate} min="0" max="100" onChange={e=>upd("cgstRate",e.target.value)} onWheel={e=>e.target.blur()}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">SGST %</label>
            <input type="number" value={form.sgstRate} min="0" max="100" onChange={e=>upd("sgstRate",e.target.value)} onWheel={e=>e.target.blur()}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">Notes</label>
            <input value={form.notes} onChange={e=>upd("notes",e.target.value)} placeholder="Optional notes"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={handleSave} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">{editId?"Update":"Add Product"}</button>
          {editId&&<button onClick={()=>{setForm({...EMPTY_P});setEditId(null);}} className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-4 py-2 rounded-lg text-sm">Cancel</button>}
        </div>
      </div>

      {/* Search + list */}
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search products…"
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
      {filtered.length===0&&<p className="text-sm text-gray-400 text-center py-8">No products yet. Add one above.</p>}
      <div className="space-y-2">
        {filtered.map(p=>{
          const up = computedPrice(p.brand, p.material, p.weightG);
          return (
            <div key={p.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between gap-4 hover:shadow-sm transition-all">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-bold text-slate-800">{p.name}</p>
                  {p.productType==="other"&&<span className="text-xs bg-amber-100 text-amber-700 font-semibold px-2 py-0.5 rounded-full">Pcs</span>}
                  {p.brand&&<span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{p.brand}</span>}
                  {p.productType!=="other"&&p.material&&<span className="text-xs bg-indigo-100 text-indigo-700 font-semibold px-2 py-0.5 rounded-full">{p.material}</span>}
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  {p.hsn&&<span className="text-xs text-gray-400">HSN {p.hsn}</span>}
                  {p.productType!=="other"&&p.weightG>0&&<span className="text-xs text-gray-500">{p.weightG}g</span>}
                  {(p.productType==="other"?p.unitPrice>0:up)&&<span className="text-xs text-emerald-600 font-semibold">₹{p.productType==="other"?p.unitPrice:up}</span>}
                  <span className="text-xs text-gray-400">CGST {p.cgstRate}% SGST {p.sgstRate}%</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={()=>handleEdit(p)} className="text-xs text-indigo-600 border border-indigo-200 hover:bg-indigo-50 px-3 py-1.5 rounded-lg">Edit</button>
                <button onClick={()=>handleDelete(p.id)} className="text-xs text-red-400 border border-red-100 hover:bg-red-50 px-2.5 py-1.5 rounded-lg">×</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Settings({ sbUrl="", setSbUrl=()=>{}, sbKey="", setSbKey=()=>{}, seller, setSeller, series, setSeries, recipients=[], setRecipients, upsertRecipient=()=>{}, allRecipients=[], toast=()=>{}, syncStatus="" }) {
  const [s,setS]=useState({...seller}); const [sr,setSr]=useState({...series});
  const [showSetup,setShowSetup]=useState(false);
  const logoRef=useRef();
  const sigRef=useRef();

  const handleLogo = e => { const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>setS(p=>({...p,logo:ev.target.result})); r.readAsDataURL(f); };
  const handleSig = e => { const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>setS(p=>({...p,signatory:ev.target.result})); r.readAsDataURL(f); };
  const save = () => { setSeller(s); setSeries(sr); toast("Settings saved"); };
  const cancel = () => { setS({...seller}); setSr({...series}); };

  const pB2C = buildOrderNo(sr,"B2C",[]); const pB2B = buildOrderNo(sr,"B2B",[]);
  const qtPeriod2 = sr.qtFormat==="YYYYMM"?yyyymm():sr.qtFormat==="YYYY"?yyyy():sr.qtFormat==="YYYYMMDD"?yyyymmdd():"";
  const pfPeriod = sr.pfFormat==="YYYYMM"?yyyymm():sr.pfFormat==="YYYY"?yyyy():sr.pfFormat==="YYYYMMDD"?yyyymmdd():"";
  const tiPeriod = sr.tiFormat==="YYYYMM"?yyyymm():sr.tiFormat==="YYYY"?yyyy():sr.tiFormat==="YYYYMMDD"?yyyymmdd():"";
  const qtPrev = [[sr.qtPrefix,qtPeriod2].filter(Boolean).join("/"),String(1).padStart(Number(sr.qtDigits)||6,"0")].join("/");
  const pfPrev = [[sr.pfPrefix,pfPeriod].filter(Boolean).join("/"),String(1).padStart(Number(sr.invDigits)||6,"0")].join("/");
  const tiPrev = [[sr.tiPrefix,tiPeriod].filter(Boolean).join("/"),String(1).padStart(Number(sr.invDigits)||6,"0")].join("/");

  const formatOpts = [{value:"NONE",label:"None (no date)"},{value:"YYYY",label:"YYYY – e.g. 2025"},{value:"YYYYMM",label:"YYYYMM – e.g. 202501"},{value:"YYYYMMDD",label:"YYYYMMDD – e.g. 20250107"}];
  const digitOpts = ["3","4","5","6"].map(d=>({value:d,label:`${d} digits`}));

  return (
    <div className="space-y-8 max-w-2xl">
      {/* Business */}
      <section>
        <h3 className="font-bold text-gray-800 mb-4">Business Details</h3>
        <div className="grid grid-cols-2 gap-4">
          <F label="Company Name" value={s.name} onChange={v=>setS({...s,name:v})} className="col-span-2"/>
          <F label="GSTIN" value={s.gstin} onChange={v=>setS({...s,gstin:v})}/><F label="State" value={s.state} onChange={v=>setS({...s,state:v})}/>
          <F label="State Code" value={s.stateCode} onChange={v=>setS({...s,stateCode:v})}/>
          <F label="Address" value={s.address} onChange={v=>setS({...s,address:v})} rows={2} className="col-span-2"/>
          <F label="Phone" value={s.phone} onChange={v=>setS({...s,phone:v})}/><F label="Email" value={s.email} onChange={v=>setS({...s,email:v})}/>
          <F label="Bank Name" value={s.bank} onChange={v=>setS({...s,bank:v})}/><F label="Account Number" value={s.accountNo} onChange={v=>setS({...s,accountNo:v})}/>
          <F label="IFSC Code" value={s.ifsc} onChange={v=>setS({...s,ifsc:v})}/>
        </div>
      </section>

      {/* Logo */}
      <section className="border-t pt-6">
        <h3 className="font-bold text-gray-800 mb-2">Company Logo</h3>
        <p className="text-xs text-gray-400 mb-4">Displayed top-left on every printed invoice. PNG/JPG recommended.</p>
        <div className="flex items-center gap-4">
          {s.logo
            ? <div className="relative group"><img src={s.logo} alt="logo" className="h-16 max-w-[160px] object-contain border rounded-xl p-2 bg-white shadow-sm"/>
                <button onClick={()=>setS({...s,logo:""})} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center hover:bg-red-600">×</button></div>
            : <div onClick={()=>logoRef.current.click()} className="h-16 w-36 border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center justify-center cursor-pointer hover:border-indigo-400 hover:bg-indigo-50 transition-all gap-1">
                <span className="text-lg">🖼</span><span className="text-xs text-gray-400">Upload logo</span>
              </div>
          }
          <button onClick={()=>logoRef.current.click()} className="text-xs text-indigo-600 hover:underline">{s.logo?"Change":"Upload"} logo</button>
          <input ref={logoRef} type="file" accept="image/*" className="hidden" onChange={handleLogo}/>
        </div>
      </section>

      {/* Authorised Signatory */}
      <section className="border-t pt-6">
        <h3 className="font-bold text-gray-800 mb-2">Authorised Signatory</h3>
        <p className="text-xs text-gray-400 mb-4">Upload a stamp/signature image shown bottom-right on every invoice. PNG with transparent background works best.</p>
        <div className="flex items-center gap-4">
          {s.signatory
            ? <div className="relative group"><img src={s.signatory} alt="signatory" className="h-20 max-w-[200px] object-contain border rounded-xl p-2 bg-white shadow-sm"/>
                <button onClick={()=>setS({...s,signatory:""})} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center hover:bg-red-600">×</button></div>
            : <div onClick={()=>sigRef.current.click()} className="h-20 w-44 border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center justify-center cursor-pointer hover:border-indigo-400 hover:bg-indigo-50 transition-all gap-1">
                <span className="text-2xl">🖋</span><span className="text-xs text-gray-400">Upload stamp / signature</span>
              </div>
          }
          <button onClick={()=>sigRef.current.click()} className="text-xs text-indigo-600 hover:underline">{s.signatory?"Change":"Upload"} stamp</button>
          <input ref={sigRef} type="file" accept="image/*" className="hidden" onChange={handleSig}/>
        </div>
      </section>

      {/* Number Series */}
      <section className="border-t pt-6">
        <h3 className="font-bold text-gray-800 mb-1">Number Series</h3>
        <p className="text-xs text-gray-400 mb-4">Customize order and invoice number formats. B2B orders auto-get <code className="bg-gray-100 px-1 rounded text-xs">-B</code> suffix.</p>

        <div className="space-y-3">
          <div className="bg-slate-50 rounded-xl p-4 space-y-3">
            <p className="text-xs font-bold text-slate-600 uppercase tracking-wide">Order Numbers</p>
            <div className="grid grid-cols-3 gap-3">
              <F label="Prefix" value={sr.prefix} onChange={v=>setSr({...sr,prefix:v})} placeholder="ORD"/>
              <S label="Date Format" value={sr.format} onChange={v=>setSr({...sr,format:v})} options={formatOpts}/>
              <S label="Seq Digits" value={sr.digits} onChange={v=>setSr({...sr,digits:v})} options={digitOpts}/>
            </div>
            <div className="flex gap-6 text-xs pt-1">
              <span className="text-gray-500">B2C: <span className="font-mono font-bold text-emerald-600">{pB2C}</span></span>
              <span className="text-gray-500">B2B: <span className="font-mono font-bold text-blue-600">{pB2B}</span></span>
            </div>
          </div>

          <div className="bg-slate-50 rounded-xl p-4 space-y-3">
            <p className="text-xs font-bold text-slate-600 uppercase tracking-wide">Quotation Numbers</p>
            <div className="grid grid-cols-3 gap-3">
              <F label="Prefix" value={sr.qtPrefix} onChange={v=>setSr({...sr,qtPrefix:v})} placeholder="QT"/>
              <S label="Date Format" value={sr.qtFormat} onChange={v=>setSr({...sr,qtFormat:v})} options={formatOpts}/>
              <S label="Seq Digits" value={sr.qtDigits||"6"} onChange={v=>setSr({...sr,qtDigits:v})} options={digitOpts}/>
            </div>
            <p className="text-xs text-gray-500">Preview: <span className="font-mono font-bold text-sky-600">{qtPrev}</span></p>
          </div>

          <div className="bg-slate-50 rounded-xl p-4 space-y-3">
            <p className="text-xs font-bold text-slate-600 uppercase tracking-wide">Proforma Invoice Numbers</p>
            <div className="grid grid-cols-3 gap-3">
              <F label="Prefix" value={sr.pfPrefix} onChange={v=>setSr({...sr,pfPrefix:v})} placeholder="PF"/>
              <S label="Date Format" value={sr.pfFormat} onChange={v=>setSr({...sr,pfFormat:v})} options={formatOpts}/>
              <S label="Seq Digits" value={sr.invDigits} onChange={v=>setSr({...sr,invDigits:v})} options={digitOpts}/>
            </div>
            <p className="text-xs text-gray-500">Preview: <span className="font-mono font-bold text-indigo-600">{pfPrev}</span></p>
          </div>

          <div className="bg-slate-50 rounded-xl p-4 space-y-3">
            <p className="text-xs font-bold text-slate-600 uppercase tracking-wide">Tax Invoice Numbers</p>
            <div className="grid grid-cols-3 gap-3">
              <F label="Prefix" value={sr.tiPrefix} onChange={v=>setSr({...sr,tiPrefix:v})} placeholder="TAX"/>
              <S label="Date Format" value={sr.tiFormat} onChange={v=>setSr({...sr,tiFormat:v})} options={formatOpts}/>
              <S label="Seq Digits" value={sr.invDigits} onChange={v=>setSr({...sr,invDigits:v})} options={digitOpts}/>
            </div>
            <p className="text-xs text-gray-500">Preview: <span className="font-mono font-bold text-slate-700">{tiPrev}</span></p>
          </div>
        </div>
      </section>

      {/* Terms & Conditions */}
      <section className="border-t pt-6">
        <h3 className="font-bold text-gray-800 mb-1">Terms & Conditions</h3>
        <p className="text-xs text-gray-400 mb-4">Printed at the bottom of each invoice. Leave blank to omit.</p>
        <div className="space-y-4">
          <F label="Proforma Invoice — Terms & Conditions" value={s.pfTerms} onChange={v=>setS({...s,pfTerms:v})} rows={4} placeholder="Enter terms for proforma invoices…"/>
          <F label="Tax Invoice — Terms & Conditions" value={s.tiTerms} onChange={v=>setS({...s,tiTerms:v})} rows={4} placeholder="Enter terms for tax invoices…"/>
        </div>
      </section>


      <section className="border-t pt-6 space-y-0">
        <div className="flex items-center justify-between gap-4 py-3">
          <p className="text-sm font-semibold text-gray-700">Database Connection</p>
          {(sbUrl&&sbKey)
            ? <span className="text-xs text-emerald-600 font-semibold bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full">Connected</span>
            : <span className="text-xs text-red-500 font-semibold bg-red-50 border border-red-200 px-3 py-1 rounded-full">Not connected</span>
          }
        </div>
        <div className="border-t border-dashed border-gray-200"/>
        <div className="flex items-center justify-between gap-4 py-3">
          <p className="text-sm font-semibold text-gray-700">Sync Status</p>
          {syncStatus==="" && <span className="text-xs text-gray-500 font-semibold bg-gray-50 border border-gray-200 px-3 py-1 rounded-full">All changes saved</span>}
          {syncStatus==="saving" && <span className="text-xs text-indigo-600 font-semibold bg-indigo-50 border border-indigo-200 px-3 py-1 rounded-full animate-pulse">Saving…</span>}
          {syncStatus==="saved" && <span className="text-xs text-emerald-600 font-semibold bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full">Saved</span>}
          {syncStatus==="error" && <span className="text-xs text-red-500 font-semibold bg-red-50 border border-red-200 px-3 py-1 rounded-full">Sync failed</span>}
        </div>
      </section>

      <section className="border-t pt-6 space-y-3">
        <h2 className="text-base font-bold text-gray-800 border-b pb-2">Recipients</h2>
        <p className="text-xs text-gray-400">People or companies who can receive payments — available as a dropdown when recording advance or payments.</p>
        <RecipientMaster recipients={recipients} setRecipients={setRecipients} upsertRecipient={upsertRecipient} allRecipients={allRecipients}/>
      </section>

      <div className="flex gap-3 pt-2 border-t">
        <button onClick={save} className="px-6 py-2.5 rounded-lg font-semibold text-sm bg-indigo-600 hover:bg-indigo-700 text-white transition-all">Save All Settings</button>
        <button onClick={cancel} className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-5 py-2.5 rounded-lg text-sm font-semibold">Cancel</button>
      </div>
    </div>
  );
}

// ─── Recipient Master ─────────────────────────────────────────────────────────
const EMPTY_RECIPIENT = { id:"", name:"" };

function RecipientMaster({ recipients, setRecipients, upsertRecipient=()=>{}, allRecipients=[] }) {
  const [form, setForm] = useState({...EMPTY_RECIPIENT});
  const [editId, setEditId] = useState(null);
  const [search, setSearch] = useState("");
  const upd = (k,v) => setForm(p=>({...p,[k]:v}));

  const handleSave = () => {
    if (!form.name.trim()) return;
    if (editId) {
      setRecipients(recipients.map(r=>r.id===editId?{...form,id:editId}:r));
      setEditId(null);
    } else {
      const id = "RCP-"+String(recipients.length+1).padStart(4,"0");
      setRecipients([...recipients,{...form,id}]);
    }
    setForm({...EMPTY_RECIPIENT});
  };
  const handleEdit = (r) => { setForm({...r}); setEditId(r.id); };
  const handleDelete = (id) => { if(window.confirm("Delete this recipient?")) { const r = recipients.find(x=>x.id===id); if(r) upsertRecipient({...r, isDeleted:true}); setRecipients(recipients.filter(x=>x.id!==id)); } };
  const handleCancel = () => { setForm({...EMPTY_RECIPIENT}); setEditId(null); };

  const filtered = recipients.filter(r=>r.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="font-bold text-gray-800 mb-1">{editId?"Edit Recipient":"Add Recipient"}</h3>
        <p className="text-xs text-gray-400 mb-4">Add people or companies who can receive payments — they'll appear as a dropdown when recording advance or payments.</p>
        <div className="bg-gray-50 rounded-xl p-4 space-y-3 border border-gray-100">
          <F label="Name" value={form.name} onChange={v=>upd("name",v)} required placeholder="e.g. Rahul, Acme Pvt Ltd"/>
          <div className="flex gap-2 pt-1">
            <button onClick={handleSave} className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-semibold">{editId?"Save Changes":"Add Recipient"}</button>
            {editId&&<button onClick={handleCancel} className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-4 py-2 rounded-lg text-sm">Cancel</button>}
          </div>
        </div>
      </div>

      <div className="border-t pt-4">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search recipients…" className="border border-gray-200 rounded-lg px-4 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-400 mb-3"/>
        {filtered.length===0&&<p className="text-gray-400 text-sm text-center py-8">No recipients yet. Add one above.</p>}
        <div className="space-y-2">
          {filtered.map(r=>(
            <div key={r.id} className="border border-gray-100 rounded-xl px-4 py-3 bg-white flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-slate-800">{r.name}</span>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={()=>handleEdit(r)} className="text-xs border border-gray-200 text-gray-600 hover:bg-gray-50 px-3 py-1.5 rounded-lg">✏️ Edit</button>
                <button onClick={()=>handleDelete(r.id)} className="text-xs border border-red-100 text-red-400 hover:bg-red-50 px-3 py-1.5 rounded-lg">Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Client Master ────────────────────────────────────────────────────────────
function ClientMaster({ clients, setClients, deleteClient=()=>{}, toast=()=>{} }) {
  const [form, setForm] = useState({...EMPTY_CLIENT});
  const [clientTab, setClientTab] = useState("B2B");
  const [editId, setEditId] = useState(null);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [sameAsBilling, setSameAsBilling] = useState(false);

  const tabClients = clients.filter(c=>(c.clientType||"B2B")===clientTab);
  const filtered = tabClients.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.id.toLowerCase().includes(search.toLowerCase()) ||
    (c.gstin||"").includes(search)
  );

  const handleSave = () => {
    if (!form.name) { toast("Client name is required","error"); return; }
    if (editId) {
      setClients(clients.map(c => c.id === editId ? { ...form, id: editId } : c));
      setEditId(null);
    } else {
      const id = genClientId(clients);
      setClients([...clients, { ...form, id }]);
    }
    setForm({...EMPTY_CLIENT}); setShowForm(false); setSameAsBilling(false);
    toast(editId?"Client updated":"Client saved");
  };

  const handleEdit = (c) => { setForm({...c}); setClientTab(c.clientType||"B2B"); setEditId(c.id); setShowForm(true); setSameAsBilling(false); };
  const handleDelete = (id) => { if (window.confirm("Delete this client?")) { const updated = clients.map(c=>c.id===id?{...c,isDeleted:true}:c); setClients(updated.filter(c=>!c.isDeleted)); deleteClient(updated.find(c=>c.id===id)); } };
  const handleNew = () => { setForm({...EMPTY_CLIENT, clientType:clientTab}); setEditId(null); setShowForm(true); setSameAsBilling(false); };

  const upd = (k,v) => setForm(f=>({...f,[k]:v}));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-bold text-lg text-slate-800">Client Master</h2>
          <p className="text-xs text-gray-400">Save client details once, auto-fill on every new order.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {["B2B","B2C"].map(t=><button key={t} onClick={()=>{setClientTab(t);setShowForm(false);setEditId(null);setForm({...EMPTY_CLIENT,clientType:t});}} className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-all ${clientTab===t?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700"}`}>{t}</button>)}
          </div>
          <ExcelBtn onClick={()=>{
            exportToExcel(filtered.map(c=>({
              "ID": c.id,
              "Type": c.clientType||"B2B",
              "Name": c.name,
              "GSTIN": c.gstin||"",
              "Contact": c.contact||"",
              "Email": c.email||"",
              "Billing Name": c.billingName||"",
              "Billing Address": c.billingAddress||"",
              "State Code": c.billingStateCode||"",
              "Place of Supply": c.placeOfSupply||"",
            })), `Clients_${clientTab}_Export`);
          }}/>
          <button onClick={handleNew} className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-semibold">+ Add Client</button>
        </div>
      </div>

      {showForm && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-slate-700">{editId ? "Edit Client — "+editId : "New Client"}</h3>
            <button onClick={()=>setShowForm(false)} className="text-gray-400 hover:text-gray-600 text-xl font-bold">×</button>
          </div>

          <div>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Basic Info</p>
            <div className="grid grid-cols-2 gap-4">
              <F label={clientTab==="B2C"?"Customer Name":"Company Name"} value={form.name} onChange={v=>upd("name",v)} required className="col-span-2 md:col-span-1"/>
              {clientTab==="B2B"&&<F label="GSTIN" value={form.gstin} onChange={v=>upd("gstin",v)} placeholder="29XXXXX0000X1ZX"/>}
              <F label="Phone" value={form.contact} onChange={v=>upd("contact",v)} placeholder="+91 XXXXX XXXXX"/>
              <F label="Email" value={form.email||""} onChange={v=>upd("email",v)} placeholder="client@email.com"/>
              <F label="Place of Supply" value={form.placeOfSupply} onChange={v=>upd("placeOfSupply",v)} placeholder="e.g. Karnataka (29)"/>
            </div>
          </div>

          <div className="border-t pt-4">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Billing Address</p>
            <div className="grid grid-cols-2 gap-4">
              <F label="Name on Invoice" value={form.billingName} onChange={v=>upd("billingName",v)} placeholder="Company name or individual"/>
              <F label="State/UT Code" value={form.billingStateCode} onChange={v=>upd("billingStateCode",v)} placeholder="e.g. 29"/>
              <F label="Billing Address" value={form.billingAddress} onChange={v=>upd("billingAddress",v)} rows={2} className="col-span-2"/>
            </div>
          </div>

          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Default Shipping Address</p>
              <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                <input type="checkbox" checked={sameAsBilling} onChange={e=>{
                  const checked=e.target.checked;
                  setSameAsBilling(checked);
                  if(checked){
                    upd("shippingName", form.billingName||form.name);
                    upd("shippingContact", form.contact);
                    upd("shippingAddress", form.billingAddress);
                    upd("shippingGstin", form.gstin);
                    upd("shippingStateCode", form.billingStateCode);
                  } else {
                    ["shippingName","shippingContact","shippingAddress","shippingGstin","shippingStateCode"].forEach(k=>upd(k,""));
                  }
                }} className="rounded accent-indigo-600 w-4 h-4"/>
                <span className="font-medium text-indigo-600">Same as billing</span>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <F label="Name" value={sameAsBilling ? (form.billingName||form.name) : form.shippingName} onChange={v=>{if(!sameAsBilling)upd("shippingName",v);}} disabled={sameAsBilling}/>
              <F label="Contact Number" value={sameAsBilling ? form.contact : form.shippingContact} onChange={v=>{if(!sameAsBilling)upd("shippingContact",v);}} disabled={sameAsBilling} placeholder="+91 XXXXX XXXXX"/>
              <F label="GSTIN (if different)" value={sameAsBilling ? form.gstin : form.shippingGstin} onChange={v=>{if(!sameAsBilling)upd("shippingGstin",v);}} disabled={sameAsBilling}/>
              <F label="State/UT Code" value={sameAsBilling ? form.billingStateCode : form.shippingStateCode} onChange={v=>{if(!sameAsBilling)upd("shippingStateCode",v);}} disabled={sameAsBilling}/>
              <F label="Shipping Address" value={sameAsBilling ? form.billingAddress : form.shippingAddress} onChange={v=>{if(!sameAsBilling)upd("shippingAddress",v);}} disabled={sameAsBilling} rows={2} className="col-span-2"/>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button onClick={handleSave} className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-lg font-semibold text-sm">
              {editId ? "Update Client" : "Save Client"}
            </button>
            <button onClick={()=>setShowForm(false)} className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-4 py-2.5 rounded-lg text-sm">Cancel</button>
          </div>
        </div>
      )}

      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search clients by name, ID or GSTIN…"
        className="border border-gray-200 rounded-lg px-4 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-400"/>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <p className="text-3xl mb-2">🏢</p>
          <p className="font-medium">{tabClients.length === 0 ? `No ${clientTab} clients yet. Add your first ${clientTab} client!` : "No clients match your search."}</p>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map(c => (
          <div key={c.id} className="bg-white border border-gray-100 rounded-xl p-4 hover:shadow-md transition-all">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-slate-800">{c.name}</span>
                  <span className="text-xs font-mono bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{c.id}</span>
                </div>
                <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                  {c.gstin && <div>GSTIN: <span className="font-mono">{c.gstin}</span></div>}
                  {c.contact && <div>📞 {c.contact}</div>}
                  {c.email && <div>✉ {c.email}</div>}
                  {c.billingAddress && <div className="text-gray-400 truncate max-w-md">{c.billingAddress}</div>}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={()=>handleEdit(c)} className="text-xs border border-indigo-200 text-indigo-600 hover:bg-indigo-50 px-3 py-1.5 rounded-lg font-medium">Edit</button>
                <button onClick={()=>handleDelete(c.id)} className="text-xs border border-red-200 text-red-500 hover:bg-red-50 px-3 py-1.5 rounded-lg font-medium">Delete</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Expense Tracker ──────────────────────────────────────────────────────────
const EXPENSE_CATEGORIES = ["Electricity","Groceries","Entertainment","Filament","Resin","Rent","Debt","Travel","Asset Purchase","Miscellaneous"];
const EMPTY_EXPENSE = { id:"", date:"", paidBy:"", amount:"", category:"Miscellaneous", comment:"" };

function ExpenseTracker({ expenses, setExpenses, recipients, allRecipients=[], seller, deleteExpense=()=>{}, toast=()=>{} }) {
  const [form, setForm] = useState({...EMPTY_EXPENSE, date:today()});
  const [editId, setEditId] = useState(null);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("All");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [msg, setMsg] = useState("");
  const upd = (k,v) => setForm(p=>({...p,[k]:v}));

  const notify = (m, err=false) => { if(err){setMsg(m);setTimeout(()=>setMsg(""),2500);toast(m,"error");}else{toast(m);} };

  const handleSave = () => {
    if (!form.date) { notify("Date is required",true); return; }
    if (!form.paidBy) { notify("Recipient is required",true); return; }
    if (!form.amount || isNaN(num(form.amount))) { notify("Valid amount is required",true); return; }
    if (editId) {
      setExpenses(prev=>prev.map(e=>e.id===editId?{...form,id:editId}:e));
      setEditId(null);
    } else {
      setExpenses(prev=>[...prev,{...form,id:Date.now()}]);
    }
    setForm({...EMPTY_EXPENSE, date:today()});
    notify(editId?"Expense updated":"Expense recorded");
  };
  const handleEdit = (e) => { setForm({...e}); setEditId(e.id); window.scrollTo({top:0,behavior:"smooth"}); };
  const handleDelete = (id) => { if(window.confirm("Delete this expense?")) { const e = expenses.find(e=>e.id===id); if(e) deleteExpense({...e,isDeleted:true}); setExpenses(prev=>prev.filter(e=>e.id!==id)); } };
  const handleCancel = () => { setForm({...EMPTY_EXPENSE, date:today()}); setEditId(null); };

  const filtered = expenses
    .filter(e=>catFilter==="All"||e.category===catFilter)
    .filter(e=>!fromDate||e.date>=fromDate)
    .filter(e=>!toDate||e.date<=toDate)
    .filter(e=>{
      const rcp=e.paidBy==="__company__"?{name:seller?.name||"Company"}:recipients.find(r=>r.id===e.paidBy);
      return search===""||
        (rcp&&rcp.name.toLowerCase().includes(search.toLowerCase()))||
        e.category.toLowerCase().includes(search.toLowerCase())||
        (e.comment&&e.comment.toLowerCase().includes(search.toLowerCase()));
    })
    .slice().sort((a,b)=>b.date.localeCompare(a.date));

  const total = filtered.reduce((s,e)=>s+num(e.amount),0);
  const grandTotal = expenses.reduce((s,e)=>s+num(e.amount),0);

  return (
    <div className="space-y-6">
      {/* Form */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 space-y-3">
        <h3 className="font-bold text-gray-800 text-sm">{editId?"Edit Expense":"Record Expense"}</h3>
        {msg&&<p className="text-xs text-indigo-600 font-semibold">{msg}</p>}
        <div className="grid grid-cols-2 gap-3">
          <F label="Date" type="date" value={form.date} onChange={v=>upd("date",v)} required/>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Paid By <span className="text-red-400">*</span></label>
            <select value={form.paidBy} onChange={e=>upd("paidBy",e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
              <option value="">— Select recipient —</option>
              <option value="__company__">{seller?.name||"Company"}</option>{recipients.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <F label="Amount (₹)" type="number" value={form.amount} onChange={v=>upd("amount",v)} placeholder="0.00" required/>
          <S label="Category" value={form.category} onChange={v=>upd("category",v)} options={EXPENSE_CATEGORIES}/>
          <F label="Comment (optional)" value={form.comment} onChange={v=>upd("comment",v)} placeholder="Any notes…" className="col-span-2"/>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={handleSave} className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-semibold">{editId?"Save Changes":"Add Expense"}</button>
          {editId&&<button onClick={handleCancel} className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-4 py-2 rounded-lg text-sm">Cancel</button>}
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3">
          <p className="text-xs text-gray-400 mb-0.5">Total Expenses (All Time)</p>
          <p className="text-sm font-bold text-red-600">₹{fmt(grandTotal)}</p>
        </div>
        <div className="bg-orange-50 border border-orange-100 rounded-xl px-4 py-3">
          <p className="text-xs text-gray-400 mb-0.5">Filtered Total</p>
          <p className="text-sm font-bold text-orange-600">₹{fmt(total)}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="space-y-2">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by recipient, category or comment…" className="border border-gray-200 rounded-lg px-4 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 whitespace-nowrap">From</span>
          <input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          <span className="text-xs font-semibold text-gray-500">To</span>
          <input type="date" value={toDate} onChange={e=>setToDate(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          {(fromDate||toDate)&&<button onClick={()=>{setFromDate("");setToDate("");}} className="text-xs text-indigo-500 hover:underline">Clear</button>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 whitespace-nowrap">Category</span>
          <div className="flex gap-1 flex-wrap">
            {["All",...EXPENSE_CATEGORIES].map(c=>(
              <button key={c} onClick={()=>setCatFilter(c)} className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-all ${catFilter===c?"bg-indigo-600 border-indigo-600 text-white":"border-gray-200 text-gray-500 hover:border-indigo-300 hover:text-indigo-600"}`}>{c}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Export */}
      <div className="flex justify-end">
        <ExcelBtn onClick={()=>{
          exportToExcel(filtered.map(e=>{
            const rcp=e.paidBy==="__company__"?{name:seller?.name||"Company"}:(recipients.find(r=>r.id===e.paidBy)||allRecipients.find(r=>r.id===e.paidBy));
            return {
              "Date": e.date,
              "Paid By": rcp?.name||"",
              "Amount (₹)": num(e.amount),
              "Category": e.category||"",
              "Comment": e.comment||"",
            };
          }), "Expenses_Export");
        }}/>
      </div>
      {/* List */}
      {filtered.length===0&&<p className="text-gray-400 text-sm text-center py-10">No expenses found.</p>}
      <div className="space-y-2">
        {filtered.map(e=>{
          const rcp=e.paidBy==="__company__"?{name:seller?.name||"Company"}:(recipients.find(r=>r.id===e.paidBy)||allRecipients.find(r=>r.id===e.paidBy));
          return (
            <div key={e.id} className="border border-gray-100 rounded-xl px-4 py-3 bg-white flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-red-600">₹{fmt(e.amount)}</span>
                  <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">{e.category}</span>
                  <span className="text-xs text-gray-400">{e.date}</span>
                </div>
                {rcp&&<p className="text-xs text-indigo-500 mt-0.5">👤 {rcp.name}</p>}
                {e.comment&&<p className="text-xs text-gray-500 mt-0.5">{e.comment}</p>}
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={()=>handleEdit(e)} className="text-xs border border-gray-200 text-gray-600 hover:bg-gray-50 px-2.5 py-1.5 rounded-lg">✏️</button>
                <button onClick={()=>handleDelete(e.id)} className="text-xs border border-red-100 text-red-400 hover:bg-red-50 px-2.5 py-1.5 rounded-lg">×</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ─── Asset Manager ────────────────────────────────────────────────────────────
const ASSET_CATEGORIES = ["Printer","Computer","Furniture","Vehicle","Equipment","Electronics","Machinery","Fixture","Miscellaneous"];
const EMPTY_ASSET = { id:"", name:"", category:"Printer", purchaseDate:"", amount:"", paidBy:"", vendor:"", description:"", invoiceUrl:"", invoicePublicId:"", linkedExpenseId:"" };


const downloadInvoice = async (url, assetName) => {
  if (!url) return;
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const ext = url.match(/\.([a-z]+)($|\?)/i)?.[1] || (blob.type.includes("pdf") ? "pdf" : "jpg");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (assetName || "invoice").replace(/[^a-z0-9]/gi,"_") + "." + ext;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch(e) {
    window.open(url, "_blank"); // fallback: open directly
  }
};

const openInvoice = (url) => {
  if (!url) return;
  window.open(url, "_blank");
};

// Load PDF.js from CDN lazily
async function getPdfJs() {
  if (window._pdfjs) return window._pdfjs;
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      window._pdfjs = window.pdfjsLib;
      resolve(window._pdfjs);
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// Convert any file to a JPEG image blob
// - Images: draw onto canvas and export as JPEG
// - PDFs: render first page via PDF.js then export as JPEG
// - Other (docs etc): attempt image read, fallback to error
async function convertToImage(file) {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const isImage = file.type.startsWith("image/");

  if (isPdf) {
    const pdfjs = await getPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);
    const scale = 2; // 2x for good resolution
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return new Promise(res => canvas.toBlob(res, "image/jpeg", 0.92));
  }

  if (isImage) {
    // Re-encode as JPEG for consistency (also handles webp, bmp, etc.)
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(objectUrl);
        canvas.toBlob(resolve, "image/jpeg", 0.92);
      };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("Could not read image")); };
      img.src = objectUrl;
    });
  }

  throw new Error("Unsupported file type. Please upload an image or PDF.");
}

async function uploadToCloudinary(file, cloudName, uploadPreset) {
  // Always convert to JPEG image before uploading
  const imageBlob = await convertToImage(file);
  const imageFile = new File([imageBlob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  const fd = new FormData();
  fd.append("file", imageFile);
  fd.append("upload_preset", uploadPreset);
  fd.append("folder", "elace-assets");
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method:"POST", body:fd });
  if (!res.ok) throw new Error("Upload failed");
  const data = await res.json();
  return { url: data.secure_url, publicId: data.public_id };
}

function AssetManager({ assets=[], setAssets, deleteAsset=()=>{}, expenses=[], setExpenses, recipients=[], allRecipients=[], seller, cdnCloud="", cdnPreset="", toast=()=>{} }) {
  const [form, setForm] = useState({...EMPTY_ASSET, purchaseDate:today()});
  const [editId, setEditId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("All");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);
  const upd = (k,v) => setForm(p=>({...p,[k]:v}));

  const resolveName = (id) => {
    if (!id) return "";
    if (id === "__company__") return seller?.name || "Company";
    const r = recipients.find(r=>r.id===id)||allRecipients.find(r=>r.id===id);
    return r ? r.name : "";
  };

  const [uploadStatus, setUploadStatus] = useState(""); // "", "converting", "uploading"
  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!cdnCloud||!cdnPreset) { toast("File upload is not configured — contact admin","error"); return; }
    setUploading(true);
    try {
      const isPdf = file.type==="application/pdf"||file.name.toLowerCase().endsWith(".pdf");
      const isImage = file.type.startsWith("image/");
      if (!isPdf && !isImage) { toast("Only images and PDFs are supported","error"); return; }
      if (isPdf) setUploadStatus("converting");
      else setUploadStatus("uploading");
      const { url, publicId } = await uploadToCloudinary(file, cdnCloud, cdnPreset);
      upd("invoiceUrl", url); upd("invoicePublicId", publicId);
      toast("Invoice uploaded successfully");
    } catch(err) {
      toast(err.message||"Upload failed","error");
    } finally {
      setUploading(false);
      setUploadStatus("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleSave = () => {
    if (!form.name) { toast("Asset name is required","error"); return; }
    if (!form.purchaseDate) { toast("Purchase date is required","error"); return; }
    setSaving(true);
    const id = editId || ("AST-" + String(assets.length + 1).padStart(4,"0"));
    let linkedExpenseId = form.linkedExpenseId;

    if (num(form.amount) > 0 && form.paidBy) {
      const expComment = `Asset: ${form.name}${form.vendor ? " ("+form.vendor+")" : ""}`;
      if (editId && form.linkedExpenseId) {
        const updatedExp = { id:form.linkedExpenseId, date:form.purchaseDate, paidBy:form.paidBy, amount:num(form.amount), category:"Asset Purchase", comment:expComment, isDeleted:false };
        setExpenses(prev => prev.map(e => e.id===form.linkedExpenseId ? updatedExp : e));
      } else {
        linkedExpenseId = "EXP-AST-" + Date.now();
        const newExp = { id:linkedExpenseId, date:form.purchaseDate, paidBy:form.paidBy, amount:num(form.amount), category:"Asset Purchase", comment:expComment, isDeleted:false };
        setExpenses(prev => [...prev, newExp]);
        toast(`Expense of ₹${fmt(num(form.amount))} created for ${resolveName(form.paidBy)}`);
      }
    }

    const asset = { ...form, id, amount:num(form.amount)||0, linkedExpenseId };
    if (editId) {
      setAssets(prev => prev.map(a => a.id===editId ? asset : a));
      toast("Asset updated");
    } else {
      setAssets(prev => [...prev, asset]);
      toast("Asset saved");
    }
    setForm({...EMPTY_ASSET, purchaseDate:today()});
    setEditId(null); setShowForm(false); setSaving(false);
  };

  const handleEdit = (a) => { setForm({...a}); setEditId(a.id); setShowForm(true); window.scrollTo({top:0,behavior:"smooth"}); };

  const handleDelete = (a) => {
    if (!window.confirm(`Delete asset "${a.name}"?\n\nThe linked expense will also be removed.`)) return;
    deleteAsset(a);
    setAssets(prev => prev.filter(x => x.id !== a.id));
    if (a.linkedExpenseId) setExpenses(prev => prev.filter(e => e.id !== a.linkedExpenseId));
    toast("Asset deleted");
  };

  const filtered = assets
    .filter(a => catFilter==="All" || a.category===catFilter)
    .filter(a => !search || a.name.toLowerCase().includes(search.toLowerCase()) || (a.vendor||"").toLowerCase().includes(search.toLowerCase()))
    .slice().sort((a,b) => (b.purchaseDate||"").localeCompare(a.purchaseDate||""));

  const totalValue = filtered.reduce((s,a) => s+num(a.amount), 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-bold text-xl text-slate-800">Assets</h2>
          <p className="text-xs text-gray-400 mt-0.5">Track company assets, purchase invoices and costs.</p>
        </div>
        <div className="flex gap-2">
          <ExcelBtn onClick={()=>{
            const rows = filtered.map(a=>({
              "Asset ID": a.id,
              "Name": a.name,
              "Category": a.category,
              "Purchase Date": a.purchaseDate||"",
              "Amount (₹)": num(a.amount),
              "Paid By": resolveName(a.paidBy)||"",
              "Vendor": a.vendor||"",
              "Description": a.description||"",
              "Invoice URL": a.invoiceUrl||""
            }));
            exportToExcel(rows, "Assets_Export");
          }}/>
          <button onClick={()=>{ setForm({...EMPTY_ASSET,purchaseDate:today()}); setEditId(null); setShowForm(v=>!v); }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-semibold">
            {showForm ? "Close Form" : "+ Add Asset"}
          </button>
        </div>
      </div>

      {/* Form */}
      {showForm && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-4">
          <h3 className="font-bold text-slate-700 text-sm">{editId ? "Edit Asset — "+editId : "New Asset"}</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2"><F label="Asset Name *" value={form.name} onChange={v=>upd("name",v)} placeholder="e.g. Creality Ender 3 Pro"/></div>
            <S label="Category" value={form.category} onChange={v=>upd("category",v)} options={ASSET_CATEGORIES}/>
            <F label="Purchase Date *" type="date" value={form.purchaseDate} onChange={v=>upd("purchaseDate",v)}/>
            <F label="Vendor / Seller" value={form.vendor} onChange={v=>upd("vendor",v)} placeholder="Where was it bought?"/>
            <F label="Amount (₹)" type="number" value={form.amount} onChange={v=>{ if(v!==""&&parseFloat(v)<0)return; upd("amount",v); }} placeholder="0.00"/>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Paid By</label>
              <select value={form.paidBy} onChange={e=>upd("paidBy",e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                <option value="">— Select recipient —</option>
                <option value="__company__">{seller?.name||"Company"}</option>
                {recipients.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div className="col-span-2"><F label="Description (optional)" value={form.description} onChange={v=>upd("description",v)} rows={2} placeholder="Notes about this asset…"/></div>
          </div>

          {/* Invoice upload */}
          <div className="border-t pt-4 space-y-2">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">Purchase Invoice</p>
            {form.invoiceUrl ? (
              <div className="flex items-center gap-3 bg-white border border-gray-100 rounded-xl px-4 py-3">
                <span className="text-emerald-600 text-sm font-medium">Invoice uploaded</span>
                <button onClick={()=>openInvoice(form.invoiceUrl)} className="text-xs text-indigo-600 underline hover:text-indigo-800">View</button>
                <button onClick={()=>downloadInvoice(form.invoiceUrl, form.name)} className="text-xs text-gray-500 underline hover:text-gray-700">Download</button>
                <button onClick={()=>{ upd("invoiceUrl",""); upd("invoicePublicId",""); }} className="ml-auto text-xs text-red-500 hover:underline">Remove</button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <button onClick={()=>fileRef.current?.click()} disabled={uploading||!cdnCloud||!cdnPreset}
                  className="flex items-center gap-2 text-sm border border-indigo-200 text-indigo-600 hover:bg-indigo-50 px-4 py-2 rounded-lg font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                  {uploadStatus==="converting" ? "Converting to image…" : uploadStatus==="uploading" ? "Uploading…" : "Upload Invoice (PDF / Image)"}
                </button>
                {(!cdnCloud||!cdnPreset) && <span className="text-xs text-amber-600">File upload not configured</span>}
                <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={handleFileChange}/>
              </div>
            )}
          </div>

          {/* Auto-expense preview */}
          {num(form.amount)>0 && form.paidBy && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-sm text-blue-700 flex items-center gap-2">
              <span className="text-blue-400 text-base">ℹ</span>
              {editId && form.linkedExpenseId
                ? <span>Saving will update the linked expense — <b>₹{fmt(num(form.amount))}</b> for <b>{resolveName(form.paidBy)}</b></span>
                : <span>Saving will auto-create an expense of <b>₹{fmt(num(form.amount))}</b> for <b>{resolveName(form.paidBy)}</b></span>
              }
            </div>
          )}

          <div className="flex gap-3 pt-2 border-t">
            <button onClick={handleSave} disabled={saving||uploading}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-lg font-semibold text-sm disabled:opacity-50">
              {saving ? "Saving…" : editId ? "Update Asset" : "Save Asset"}
            </button>
            <button onClick={()=>{ setShowForm(false); setEditId(null); setForm({...EMPTY_ASSET,purchaseDate:today()}); }}
              className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-5 py-2.5 rounded-lg text-sm">Cancel</button>
          </div>
        </div>
      )}

      {/* Summary card */}
      <div className="bg-gradient-to-r from-slate-700 to-slate-900 rounded-2xl px-6 py-5 text-white flex items-center justify-between">
        <div>
          <p className="text-xs opacity-60 uppercase tracking-widest">Total Asset Value</p>
          <p className="text-3xl font-black mt-1">₹{totalValue.toLocaleString("en-IN",{minimumFractionDigits:2})}</p>
          <p className="text-xs opacity-50 mt-1">{filtered.length} asset{filtered.length!==1?"s":""} shown</p>
        </div>
      </div>

      {/* Filters */}
      <div className="space-y-2">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name or vendor…"
          className="border border-gray-200 rounded-lg px-4 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
        <div className="flex gap-1.5 flex-wrap">
          {["All",...ASSET_CATEGORIES].map(c=>(
            <button key={c} onClick={()=>setCatFilter(c)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-all ${catFilter===c?"bg-indigo-600 border-indigo-600 text-white":"border-gray-200 text-gray-500 hover:border-indigo-300"}`}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {filtered.length===0 && (
        <p className="text-gray-400 text-sm text-center py-12">{assets.length===0?"No assets yet — add your first one!":"No assets match your filters."}</p>
      )}
      <div className="space-y-3">
        {filtered.map(a=>(
          <div key={a.id} className="bg-white border border-gray-100 rounded-xl px-4 py-4 hover:shadow-md transition-all">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-slate-800">{a.name}</span>
                  <span className="text-xs font-mono bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">{a.id}</span>
                  <span className="text-xs bg-indigo-50 text-indigo-700 font-semibold border border-indigo-100 px-2 py-0.5 rounded-full">{a.category}</span>
                </div>
                <div className="grid grid-cols-4 gap-0 mt-3 border border-gray-100 rounded-lg overflow-hidden">
                  {[
                    ["Date", a.purchaseDate||"—", "text-gray-700"],
                    ["Amount", a.amount>0?`₹${fmt(num(a.amount))}`:"—", "text-emerald-700 font-bold"],
                    ["Paid By", resolveName(a.paidBy)||"—", "text-gray-700"],
                    ["Vendor", a.vendor||"—", "text-gray-700"],
                  ].map(([lbl,val,cls],i)=>(
                    <div key={i} className={`px-3 py-2 text-center ${i<3?"border-r border-gray-100":""}`}>
                      <p className="text-xs text-gray-400 mb-0.5">{lbl}</p>
                      <p className={`text-xs ${cls}`}>{val}</p>
                    </div>
                  ))}
                </div>
                {a.description && <p className="text-xs text-gray-500 mt-2">{a.description}</p>}
                <div className="flex gap-2 mt-2 flex-wrap">
                  {a.invoiceUrl && <button onClick={()=>openInvoice(a.invoiceUrl)} className="text-xs text-indigo-500 border border-indigo-200 px-2.5 py-1 rounded-lg hover:bg-indigo-50 font-medium">View Invoice</button>}
                  {a.invoiceUrl && <button onClick={()=>downloadInvoice(a.invoiceUrl, a.name)} className="text-xs text-gray-500 border border-gray-200 px-2.5 py-1 rounded-lg hover:bg-gray-50 font-medium">Download</button>}
                  {a.linkedExpenseId && <span className="text-xs text-emerald-600 bg-emerald-50 border border-emerald-100 px-2.5 py-1 rounded-lg font-medium">Expense linked</span>}
                </div>
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <button onClick={()=>handleEdit(a)} className="text-xs border border-gray-200 text-gray-600 hover:bg-gray-50 px-3 py-1.5 rounded-lg font-medium">Edit</button>
                <button onClick={()=>handleDelete(a)} className="text-xs border border-red-200 text-red-500 hover:bg-red-50 px-3 py-1.5 rounded-lg font-medium">Delete</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Income View ──────────────────────────────────────────────────────────────
function IncomeView({ orders, recipients, allRecipients=[], seller }) {
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [recipientFilter, setRecipientFilter] = useState("");
  const [modeFilter, setModeFilter] = useState("All");

  const resolveName = (id) => {
    if (!id) return "";
    if (id === "__company__") return seller?.name || "Company";
    const r = recipients.find(r => r.id === id) || allRecipients.find(r => r.id === id);
    return r ? r.name : "";
  };

  // Gather all payments: advance + payment entries
  const allPayments = [];
  orders.forEach(o => {
    if (num(o.advance) > 0) {
      allPayments.push({
        date: o.orderDate||"", orderNo: o.orderNo||"", customerName: o.customerName||"",
        amount: num(o.advance), mode: o.paymentMode||"", receivedBy: resolveName(o.advanceRecipient),
        txnRef: o.advanceTxnRef||"", note: "Advance", type: o.type||""
      });
    }
    (o.payments||[]).forEach(p => {
      if (!num(p.amount)) return;
      allPayments.push({
        date: p.date||"", orderNo: o.orderNo||"", customerName: o.customerName||"",
        amount: num(p.amount), mode: p.mode||"", receivedBy: resolveName(p.receivedBy),
        txnRef: p.txnRef||"", note: p.comments||"Payment", type: o.type||""
      });
    });
  });

  // Collect unique payment modes for filter dropdown
  const allModes = ["All", ...new Set(allPayments.map(p=>p.mode).filter(Boolean))];
  // Collect all recipients who appear in payments
  const allPayRecipients = [...new Map(allPayments.filter(p=>p.receivedBy).map(p=>[p.receivedBy,p.receivedBy])).values()];

  const filtered = allPayments
    .filter(p => !fromDate || p.date >= fromDate)
    .filter(p => !toDate || p.date <= toDate)
    .filter(p => typeFilter === "All" || p.type === typeFilter)
    .filter(p => !recipientFilter || p.receivedBy === recipientFilter)
    .filter(p => modeFilter === "All" || p.mode === modeFilter)
    .filter(p => {
      if (!search) return true;
      const s = search.toLowerCase();
      return p.orderNo.toLowerCase().includes(s)
        || p.customerName.toLowerCase().includes(s)
        || p.receivedBy.toLowerCase().includes(s)
        || p.txnRef.toLowerCase().includes(s)
        || p.note.toLowerCase().includes(s);
    })
    .sort((a,b) => b.date.localeCompare(a.date));

  const total = filtered.reduce((s,p) => s + p.amount, 0);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-bold text-lg text-slate-800">Income</h2>
          <p className="text-xs text-gray-400">All payments received across orders.</p>
        </div>
        <ExcelBtn onClick={()=>{
          exportToExcel(filtered.map(p=>({
            "Date": p.date,
            "Order No": p.orderNo,
            "Customer": p.customerName,
            "Type": p.type,
            "Amount (₹)": p.amount,
            "Mode": p.mode,
            "Received By": p.receivedBy,
            "Txn Ref": p.txnRef,
            "Note": p.note,
          })), "Income_Export");
        }}/>
      </div>
      <div className="space-y-3">
        <input value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Search by order no, customer, recipient, txn ref…"
          className="border border-gray-200 rounded-lg px-4 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500">From</span>
            <input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
            <span className="text-xs font-semibold text-gray-500">To</span>
            <input type="date" value={toDate} onChange={e=>setToDate(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
          <div className="flex gap-1">
            {["All","B2B","B2C"].map(t=><button key={t} onClick={()=>setTypeFilter(t)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${typeFilter===t?"bg-indigo-600 border-indigo-600 text-white":"border-gray-200 text-gray-500 hover:border-indigo-300"}`}>{t}</button>)}
          </div>
          <select value={recipientFilter} onChange={e=>setRecipientFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
            <option value="">All Recipients</option>
            {allPayRecipients.map(r=><option key={r} value={r}>{r}</option>)}
          </select>
          <select value={modeFilter} onChange={e=>setModeFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
            {allModes.map(m=><option key={m} value={m}>{m==="All"?"All Modes":m}</option>)}
          </select>
          {(fromDate||toDate||typeFilter!=="All"||recipientFilter||modeFilter!=="All")&&(
            <button onClick={()=>{setFromDate("");setToDate("");setTypeFilter("All");setRecipientFilter("");setModeFilter("All");}} className="text-xs text-indigo-500 hover:underline">Clear all</button>
          )}
        </div>
      </div>

      <div className="bg-gradient-to-r from-indigo-600 to-violet-600 rounded-2xl p-5 text-white">
        <p className="text-sm opacity-80">Total Received ({filtered.length} entries)</p>
        <p className="text-3xl font-black mt-1">&#x20B9;{total.toLocaleString("en-IN", {minimumFractionDigits:2})}</p>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-3xl mb-2">&#x1F4B0;</p>
          <p className="font-medium">No payments found.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((p,i) => (
            <div key={i} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between gap-4 hover:shadow-sm transition-all">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-800 text-sm">{p.customerName}</span>
                  <span className="text-xs font-mono bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{p.orderNo}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${p.type==="B2B"?"bg-blue-100 text-blue-700":"bg-emerald-100 text-emerald-700"}`}>{p.type}</span>
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <span className="text-xs text-gray-400">{p.date}</span>
                  <span className="text-xs text-gray-500">{p.note}</span>
                  {p.mode && <span className="text-xs bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full">{p.mode}</span>}
                  {p.receivedBy && <span className="text-xs text-indigo-500">&#x1F464; {p.receivedBy}</span>}
                  {p.txnRef && <span className="text-xs text-gray-400 font-mono">Ref: {p.txnRef}</span>}
                </div>
              </div>
              <span className="font-bold text-emerald-600 text-base shrink-0">+&#x20B9;{num(p.amount).toLocaleString("en-IN",{minimumFractionDigits:2})}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─── Inventory ───────────────────────────────────────────────────────────────
const FILAMENT_MATERIALS = ["PLA","PETG","ABS","ASA","TPU","Nylon","PC","PLA+","PLA-CF","PETG-CF","ABS-CF","Resin"];
const EMPTY_FILAMENT = { brand:"", material:"PLA", color:"", weightG:1000, costTotal:"", notes:"" };
const EMPTY_COST_SPLIT = () => [{ paidBy:"", amount:"" }];

function InventoryManager({ inventory=[], setInventory, expenses=[], setExpenses, recipients=[], allRecipients=[], seller, setSeller=()=>{}, deleteInventoryItem=()=>{}, toast=()=>{}, orders=[], wastageLog=[], setWastageLog=()=>{} }) {
  const [showForm, setShowForm] = useState(false);
  const [rows, setRows] = useState([{...EMPTY_FILAMENT}]);
  const [purchaseDate, setPurchaseDate] = useState(today());
  const [costSplits, setCostSplits] = useState(EMPTY_COST_SPLIT());
  const [search, setSearch] = useState("");
  const [matFilter, setMatFilter] = useState("All");
  const [brandFilter, setBrandFilter] = useState("All");
  const [grouped, setGrouped] = useState(true);
  const [materialList, setMaterialList] = useState(()=>{
    const custom = inventory.map(i=>i.material).filter(m=>m&&!FILAMENT_MATERIALS.includes(m));
    return [...FILAMENT_MATERIALS, ...[...new Set(custom)]];
  });
  const addCustomMaterial = (mat) => {
    const trimmed = mat.trim();
    if (trimmed && !materialList.includes(trimmed)) setMaterialList(prev=>[...prev, trimmed]);
  };

  const WASTE_REASONS = ["Sample / Testing","Product Prototype","Jammed / Broken","Moisture Damage","Calibration","Other"];
  const [showWasteForm, setShowWasteForm] = useState(false);
  const [wasteEntry, setWasteEntry] = useState({groupKey:"",weightG:"",reason:"Sample / Testing",orderNo:"",notes:"",date:today()});
  const updW = (k,v) => setWasteEntry(p=>({...p,[k]:v}));

  const pendingOrders = orders.filter(o=>o.status!=="Completed"&&o.status!=="Cancelled");

  const handleAddWaste = () => {
    if (!wasteEntry.groupKey) { toast("Select a filament","error"); return; }
    if (!wasteEntry.weightG||isNaN(Number(wasteEntry.weightG))||Number(wasteEntry.weightG)<=0) { toast("Enter weight","error"); return; }
    const parts = wasteEntry.groupKey.split("||");
    const entry = {
      id:"WL-"+Date.now(),
      date: wasteEntry.date||today(),
      brand: parts[0]||"",
      material: parts[1]||"",
      color: parts[2]||"",
      groupKey: wasteEntry.groupKey,
      weightG: Number(wasteEntry.weightG),
      reason: wasteEntry.reason,
      orderNo: wasteEntry.orderNo||"",
      notes: wasteEntry.notes||"",
    };
    setWastageLog(prev=>[...prev,entry]);
    setWasteEntry({groupKey:"",weightG:"",reason:"Sample / Testing",orderNo:"",notes:"",date:today()});
    setShowWasteForm(false);
    toast("Wastage recorded");
  };

  const resolveName = (id) => {
    if (!id || id==="__company__") return seller?.name||"Company";
    const r = recipients.find(r=>r.id===id)||allRecipients.find(r=>r.id===id);
    return r?r.name:"";
  };

  // Compute total grams used per spool across all orders
  const usedPerSpool = {};
  orders.forEach(o => (o.filamentUsage||[]).forEach(u => {
    usedPerSpool[u.inventoryId] = (usedPerSpool[u.inventoryId]||0) + Number(u.weightUsedG||0);
  }));
  // Also deduct standalone wastage entries by matching groupKey to inventory items
  wastageLog.forEach(w => {
    inventory.filter(i=>`${i.brand||""}||${i.material}||${i.color||""}`===w.groupKey).forEach(i=>{
      usedPerSpool[i.id] = (usedPerSpool[i.id]||0); // mark as touched; actual deduction spread below
    });
  });
  // Spread wastage across spools in the group (largest remaining first, same logic as order usage)
  const _tmpRemaining = {};
  inventory.forEach(i=>{ _tmpRemaining[i.id] = Number(i.weightG||0) - (usedPerSpool[i.id]||0); });
  wastageLog.forEach(w => {
    let wLeft = Number(w.weightG||0);
    const spools = inventory
      .filter(i=>`${i.brand||""}||${i.material}||${i.color||""}`===w.groupKey)
      .sort((a,b)=>(_tmpRemaining[b.id]||0)-(_tmpRemaining[a.id]||0));
    for (const s of spools) {
      if (wLeft<=0) break;
      const avail = Math.max(0, _tmpRemaining[s.id]||0);
      const take = Math.min(wLeft, avail);
      usedPerSpool[s.id] = (usedPerSpool[s.id]||0) + take;
      _tmpRemaining[s.id] = (_tmpRemaining[s.id]||0) - take;
      wLeft -= take;
    }
  });
  const getRemainingG = (item) => Math.max(0, Number(item.weightG||0) - (usedPerSpool[item.id]||0));

  const allBrands = ["All", ...new Set(inventory.map(i=>i.brand).filter(Boolean))];

  const filtered = inventory.filter(i=>{
    const matchMat = matFilter==="All" || i.material===matFilter;
    const matchBrand = brandFilter==="All" || i.brand===brandFilter;
    const matchSearch = !search ||
      i.brand.toLowerCase().includes(search.toLowerCase()) ||
      i.color.toLowerCase().includes(search.toLowerCase()) ||
      i.material.toLowerCase().includes(search.toLowerCase()) ||
      (i.notes||"").toLowerCase().includes(search.toLowerCase());
    return matchMat && matchBrand && matchSearch;
  }).sort((a,b)=>(b.purchaseDate||"").localeCompare(a.purchaseDate||""));

  const totalWeight = filtered.reduce((s,i)=>s+Number(i.weightG||0),0);
  const totalRemaining = filtered.reduce((s,i)=>s+getRemainingG(i),0);

  const updRow = (idx,k,v) => setRows(r=>r.map((row,i)=>i===idx?{...row,[k]:v}:row));
  const addRow = () => setRows(r=>[...r,{...EMPTY_FILAMENT}]);
  const removeRow = (idx) => setRows(r=>r.filter((_,i)=>i!==idx));
  const updSplit = (idx,k,v) => setCostSplits(s=>s.map((sp,i)=>i===idx?{...sp,[k]:v}:sp));
  const addSplit = () => setCostSplits(s=>[...s,{paidBy:"",amount:""}]);
  const removeSplit = (idx) => setCostSplits(s=>s.filter((_,i)=>i!==idx));
  const totalSplit = costSplits.reduce((s,sp)=>s+Number(sp.amount||0),0);

  const matColors = {
    PLA:"bg-green-100 text-green-700", PETG:"bg-blue-100 text-blue-700",
    ABS:"bg-orange-100 text-orange-700", ASA:"bg-amber-100 text-amber-700",
    TPU:"bg-purple-100 text-purple-700", Nylon:"bg-cyan-100 text-cyan-700",
    PC:"bg-slate-100 text-slate-700", "PLA+":"bg-emerald-100 text-emerald-700",
    "PLA-CF":"bg-gray-100 text-gray-700","PETG-CF":"bg-indigo-100 text-indigo-700",
    "ABS-CF":"bg-red-100 text-red-700", Resin:"bg-pink-100 text-pink-700",
    Other:"bg-gray-100 text-gray-500",
  };

  const handleSave = () => {
    const validRows = rows.filter(r=>r.brand||r.color||r.material);
    if (!validRows.length) { toast("Add at least one filament","error"); return; }
    if (!purchaseDate) { toast("Purchase date is required","error"); return; }
    const newItems = validRows.map(r=>({
      id:"FIL-"+Date.now()+"-"+Math.random().toString(36).slice(2,6),
      brand:r.brand, material:r.material, color:r.color,
      weightG:Number(r.weightG)||1000, notes:r.notes||"",
      purchaseDate, costTotal:Number(r.costTotal)||0, linkedExpenseIds:[],
    }));
    const newExpenses = [];
    if (totalSplit>0) {
      const desc = validRows.map(r=>`${r.brand||"?"} ${r.material} ${r.color||""}`.trim()).join(", ");
      costSplits.forEach(sp=>{
        if (!sp.paidBy || !Number(sp.amount)) return;
        const expId = "EXP-INV-"+Date.now()+"-"+Math.random().toString(36).slice(2,6);
        newExpenses.push({ id:expId, date:purchaseDate, paidBy:sp.paidBy, amount:Number(sp.amount), category:"Filament", comment:`Filament purchase: ${desc}` });
      });
      newItems.forEach(item=>{ item.linkedExpenseIds = newExpenses.map(e=>e.id); });
    }
    setInventory(prev=>[...prev,...newItems]);
    if (newExpenses.length) setExpenses(prev=>[...prev,...newExpenses]);
    setRows([{...EMPTY_FILAMENT}]);
    setCostSplits(EMPTY_COST_SPLIT());
    setPurchaseDate(today());
    setShowForm(false);
    toast(`Added ${newItems.length} filament${newItems.length>1?"s":""}${newExpenses.length?" + "+newExpenses.length+" expense"+(newExpenses.length>1?"s":""):""}`);
  };

  const handleDelete = (item) => {
    if (!window.confirm("Delete this filament entry?")) return;
    setInventory(prev=>prev.filter(i=>i.id!==item.id));
    deleteInventoryItem(item);
  };

  const byMaterial = {};
  filtered.forEach(i=>{ if(!byMaterial[i.material]) byMaterial[i.material]={count:0,nonEmpty:0,weight:0,remaining:0}; byMaterial[i.material].count++; const r=getRemainingG(i); byMaterial[i.material].weight+=Number(i.weightG||0); byMaterial[i.material].remaining+=r; if(r>0) byMaterial[i.material].nonEmpty++; });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-bold text-lg text-slate-800">Filament Inventory</h2>
          <p className="text-xs text-gray-400">Track filament stock by brand, material and colour.</p>
        </div>
        <button onClick={()=>setShowForm(v=>!v)} className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-semibold shrink-0">
          {showForm?"Cancel":"+ Add Stock"}
        </button>
      </div>

      {showForm&&(
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h3 className="font-bold text-slate-700 text-sm">New Filament Purchase</h3>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Purchase Date <span className="text-red-400">*</span></label>
              <input type="date" value={purchaseDate} onChange={e=>setPurchaseDate(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"/>
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Filaments</p>
            {rows.map((row,idx)=>(
              <div key={idx} className="bg-white border border-gray-100 rounded-xl p-3 relative">
                {rows.length>1&&<button onClick={()=>removeRow(idx)} className="absolute top-2 right-2 text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>}
                <div className="grid grid-cols-2 gap-3 pr-5">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Brand</label>
                    <input value={row.brand} onChange={e=>updRow(idx,"brand",e.target.value)} placeholder="e.g. Bambu, eSUN, Sunlu…"
                      className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Material</label>
                    <select value={materialList.includes(row.material)?row.material:"__custom__"}
                      onChange={e=>{ if(e.target.value==="__custom__") updRow(idx,"material",""); else updRow(idx,"material",e.target.value); }}
                      className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                      {materialList.map(m=><option key={m} value={m}>{m}</option>)}
                      <option value="__custom__">Other (custom)…</option>
                    </select>
                    {!materialList.includes(row.material)&&(
                      <input value={row.material} onChange={e=>updRow(idx,"material",e.target.value)}
                        onBlur={e=>{ if(e.target.value.trim()) addCustomMaterial(e.target.value); }}
                        onKeyDown={e=>{ if(e.key==="Enter"&&e.target.value.trim()){ addCustomMaterial(e.target.value); updRow(idx,"material",e.target.value.trim()); e.target.blur(); } }}
                        placeholder="Type material name…" autoFocus
                        className="mt-1 border border-indigo-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Colour</label>
                    <input value={row.color} onChange={e=>updRow(idx,"color",e.target.value)} placeholder="e.g. Black, Galaxy Silver…"
                      className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Weight (g)</label>
                    <input type="number" value={row.weightG} min="0" onChange={e=>updRow(idx,"weightG",e.target.value)} onWheel={e=>e.target.blur()}
                      className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Cost (₹) <span className="text-gray-300 font-normal normal-case">per spool</span></label>
                    <input type="number" value={row.costTotal} min="0" onChange={e=>updRow(idx,"costTotal",e.target.value)} onWheel={e=>e.target.blur()} placeholder="0.00"
                      className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Notes</label>
                    <input value={row.notes} onChange={e=>updRow(idx,"notes",e.target.value)} placeholder="Optional…"
                      className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                  </div>
                </div>
              </div>
            ))}
            <button onClick={addRow} className="w-full text-xs border border-dashed border-indigo-300 text-indigo-500 hover:bg-indigo-50 py-2 rounded-lg font-semibold transition-all">
              + Add Another Filament
            </button>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Cost Split <span className="text-gray-400 font-normal normal-case text-xs">auto-adds to Expenses tab</span></p>
            {costSplits.map((sp,idx)=>(
              <div key={idx} className="flex items-end gap-2">
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-xs font-semibold text-gray-500">Paid By</label>
                  <select value={sp.paidBy} onChange={e=>updSplit(idx,"paidBy",e.target.value)}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                    <option value="">— Select —</option>
                    <option value="__company__">{seller?.name||"Company"}</option>
                    {recipients.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1 w-36">
                  <label className="text-xs font-semibold text-gray-500">Amount (₹)</label>
                  <input type="number" value={sp.amount} min="0" onChange={e=>updSplit(idx,"amount",e.target.value)} onWheel={e=>e.target.blur()} placeholder="0.00"
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                </div>
                {costSplits.length>1&&<button onClick={()=>removeSplit(idx)} className="text-red-400 hover:text-red-600 font-bold text-xl pb-1.5 leading-none">×</button>}
              </div>
            ))}
            <div className="flex items-center justify-between">
              <button onClick={addSplit} className="text-xs text-indigo-500 hover:underline font-semibold">+ Add split</button>
              {totalSplit>0&&<span className="text-xs font-bold text-gray-600">Total: ₹{fmt(totalSplit)}</span>}
            </div>
          </div>

          <div className="flex gap-2 pt-1 border-t border-gray-100">
            <button onClick={handleSave} className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-semibold">Save Stock</button>
            <button onClick={()=>{setShowForm(false);setRows([{...EMPTY_FILAMENT}]);setCostSplits(EMPTY_COST_SPLIT());}} className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-4 py-2 rounded-lg text-sm">Cancel</button>
          </div>
        </div>
      )}

      {Object.keys(byMaterial).length>0&&(
        <div className="flex flex-wrap gap-2">
          {Object.entries(byMaterial).map(([mat,v])=>(
            <div key={mat} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ${matColors[mat]||"bg-gray-100 text-gray-600"}`}>
              <span>{mat}</span><span className="opacity-50">·</span>
              <span>{v.nonEmpty} spool{v.nonEmpty!==1?"s":""} left</span><span className="opacity-50">·</span>
              <span>{(v.remaining/1000).toFixed(2)} kg left</span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search brand, material, colour…"
          className="border border-gray-200 rounded-lg px-4 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs font-semibold text-gray-500">Material</span>
          <div className="flex flex-wrap gap-1">
            {["All",...materialList].map(m=>(
              <button key={m} onClick={()=>setMatFilter(m)} className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${matFilter===m?"bg-indigo-600 border-indigo-600 text-white":"border-gray-200 text-gray-500 hover:border-indigo-300 hover:text-indigo-600"}`}>{m}</button>
            ))}
          </div>
        </div>
        {allBrands.length>2&&(
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs font-semibold text-gray-500">Brand</span>
            <div className="flex flex-wrap gap-1">
              {allBrands.map(b=>(
                <button key={b} onClick={()=>setBrandFilter(b)} className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${brandFilter===b?"bg-indigo-600 border-indigo-600 text-white":"border-gray-200 text-gray-500 hover:border-indigo-300 hover:text-indigo-600"}`}>{b}</button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-400">{filtered.length} spool{filtered.length!==1?"s":""} · {(totalRemaining/1000).toFixed(2)} kg remaining of {(totalWeight/1000).toFixed(2)} kg</p>
          <ExcelBtn onClick={()=>exportToExcel(filtered.map(i=>({
            "Brand":i.brand,"Material":i.material,"Colour":i.color,
            "Weight (g)":i.weightG,"Cost (₹)":i.costTotal||0,
            "Purchase Date":i.purchaseDate,"Notes":i.notes||"",
          })),"Inventory_Export")}/>
        </div>
      </div>

      {/* View toggle */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-500">View</span>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {[["grouped","Grouped"],["individual","Individual"]].map(([v,l])=>(
            <button key={v} onClick={()=>setGrouped(v==="grouped")} className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${(grouped&&v==="grouped")||(!grouped&&v==="individual")?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700"}`}>{l}</button>
          ))}
        </div>
      </div>

      {filtered.length===0&&<p className="text-gray-400 text-sm text-center py-12">No filaments found. Add some stock!</p>}

      {/* Grouped view */}
      {grouped&&filtered.length>0&&(()=>{
        const groups = {};
        filtered.forEach(item=>{
          const key = `${item.brand||""}||${item.material}||${item.color||""}`;
          if (!groups[key]) groups[key] = { brand:item.brand, material:item.material, color:item.color, items:[], totalWeight:0, totalRemaining:0, totalCost:0 };
          const rem = getRemainingG(item);
          groups[key].items.push(item);
          groups[key].totalWeight += Number(item.weightG||0);
          groups[key].totalRemaining += rem;
          groups[key].totalCost += Number(item.costTotal||0);
        });
        return (
          <div className="space-y-2">
            {Object.values(groups).map((g,gi)=>{
              const pct = g.totalWeight>0 ? Math.round(g.totalRemaining/g.totalWeight*100) : 100;
              const c = pct>50?"text-emerald-600":pct>20?"text-amber-500":"text-red-500";
              const barC = pct>50?"bg-emerald-400":pct>20?"bg-amber-400":"bg-red-400";
              return (
                <div key={gi} className="bg-white border border-gray-100 rounded-xl px-4 py-3 hover:shadow-sm transition-all">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className={`px-2.5 py-1 rounded-full text-xs font-bold shrink-0 ${matColors[g.material]||"bg-gray-100 text-gray-600"}`}>{g.material}</div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-slate-800">{g.brand||<span className="text-gray-400 font-normal">No brand</span>} <span className="font-normal text-gray-500">— {g.color||"No colour"}</span></p>
                        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                          <span className="text-xs text-gray-500">{g.spoolsLeft||0} of {g.items.length} spool{g.items.length!==1?"s":""} left · {(g.totalWeight/1000).toFixed(2)} kg total</span>
                          <span className={`text-xs font-bold ${c}`}>{g.totalRemaining.toFixed(0)}g left ({pct}%)</span>
                          {g.totalCost>0&&<span className="text-xs text-emerald-600 font-semibold">₹{fmt(g.totalCost)}</span>}
                        </div>
                        {/* Progress bar */}
                        <div className="mt-1.5 h-1.5 bg-gray-100 rounded-full overflow-hidden w-full max-w-xs">
                          <div className={`h-full rounded-full transition-all ${barC}`} style={{width:`${pct}%`}}/>
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* Individual spools under group */}
                  <div className="mt-2 space-y-1 pl-11">
                    {g.items.filter(item=>getRemainingG(item)>0).map(item=>{
                      const rem=getRemainingG(item); const p2=Math.round(rem/Number(item.weightG||1)*100);
                      const c2=p2>50?"text-emerald-600":p2>20?"text-amber-500":"text-red-500";
                      return (
                        <div key={item.id} className="flex items-center justify-between gap-2 bg-gray-50 rounded-lg px-3 py-1.5">
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-xs text-gray-400">{item.purchaseDate}</span>
                            <span className="text-xs text-gray-500">{(Number(item.weightG)/1000).toFixed(2)} kg</span>
                            {usedPerSpool[item.id]&&<span className={`text-xs font-semibold ${c2}`}>{rem.toFixed(0)}g left ({p2}%)</span>}
                            {item.notes&&<span className="text-xs text-gray-400 italic">{item.notes}</span>}
                          </div>
                          <button onClick={()=>handleDelete(item)} className="text-xs text-red-300 hover:text-red-500 font-bold leading-none shrink-0">×</button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Individual view */}
      {!grouped&&(
      <div className="space-y-2">
        {filtered.map(item=>(
          <div key={item.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between gap-4 hover:shadow-sm transition-all">
            <div className="flex items-center gap-3 min-w-0">
              <div className={`px-2.5 py-1 rounded-full text-xs font-bold shrink-0 ${matColors[item.material]||"bg-gray-100 text-gray-600"}`}>{item.material}</div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800">{item.brand||<span className="text-gray-400 font-normal">No brand</span>} <span className="font-normal text-gray-500">— {item.color||"No colour"}</span></p>
                <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                  <span className="text-xs text-gray-400">{item.purchaseDate}</span>
                  <span className="text-xs text-gray-500">{(Number(item.weightG)/1000).toFixed(2)} kg</span>
                  {(()=>{ const rem=getRemainingG(item); const pct=Math.round(rem/Number(item.weightG||1)*100); const c=pct>50?"text-emerald-600":pct>20?"text-amber-500":"text-red-500"; return usedPerSpool[item.id]?<span className={`text-xs font-bold ${c}`}>{rem.toFixed(0)}g left ({pct}%)</span>:null; })()}
                  {item.costTotal>0&&<span className="text-xs text-emerald-600 font-semibold">₹{fmt(item.costTotal)}</span>}
                  {item.notes&&<span className="text-xs text-gray-400 italic truncate max-w-[160px]">{item.notes}</span>}
                </div>
              </div>
            </div>
            <button onClick={()=>handleDelete(item)} className="text-xs border border-red-100 text-red-400 hover:bg-red-50 px-2.5 py-1.5 rounded-lg shrink-0 transition-all">×</button>
          </div>
        ))}
      </div>
      )}

      {/* ── Filament Price Per Gram ────────────────────────────────────────── */}
      <div className="mt-6 border-t border-gray-100 pt-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-bold text-slate-700">Price Per Gram</p>
            <p className="text-xs text-gray-400">Set ₹/g for each brand + material. Used to auto-calculate product prices.</p>
          </div>
        </div>
        {(()=>{
          const fps = seller?.filamentPrices || {};
          const entries = Object.entries(fps);
          return (
            <div className="space-y-2">
              {entries.map(([key,ppg])=>{
                const [brand,mat] = key.split("||");
                return (
                  <div key={key} className="flex items-center gap-2">
                    <input value={brand} readOnly placeholder="Brand" className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600 text-xs"/>
                    <input value={mat} readOnly placeholder="Material" className="w-24 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600 text-xs"/>
                    <span className="text-gray-400 text-xs shrink-0">₹/g</span>
                    <input type="number" value={ppg} min="0" step="0.01"
                      onChange={e=>{ const nfp={...fps,[key]:e.target.value}; setSeller({...seller,filamentPrices:nfp}); }}
                      onWheel={e=>e.target.blur()} placeholder="0.00"
                      className="w-20 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                    <button onClick={()=>{ const nfp={...fps}; delete nfp[key]; setSeller({...seller,filamentPrices:nfp}); }}
                      className="text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>
                  </div>
                );
              })}
              {(()=>{
                const [nb,setNb]=useState(""); const [nm,setNm]=useState(materialList[0]||"PLA"); const [np,setNp]=useState("");
                return (
                  <div className="flex items-center gap-2 mt-1">
                    <input value={nb} onChange={e=>setNb(e.target.value)} placeholder="Brand (e.g. Bambu)"
                      className="flex-1 border border-indigo-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 text-xs"/>
                    <select value={nm} onChange={e=>setNm(e.target.value)}
                      className="w-24 border border-indigo-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white text-xs">
                      {materialList.map(m=><option key={m}>{m}</option>)}
                    </select>
                    <span className="text-gray-400 text-xs shrink-0">₹/g</span>
                    <input type="number" value={np} min="0" step="0.01" onChange={e=>setNp(e.target.value)} onWheel={e=>e.target.blur()} placeholder="0.00"
                      className="w-20 border border-indigo-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                    <button onClick={()=>{
                      if (!np||isNaN(Number(np))) return;
                      const k=`${nb.trim()}||${nm}`;
                      const nfp={...fps,[k]:np};
                      setSeller({...seller,filamentPrices:nfp});
                      setNb(""); setNp("");
                    }} className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg text-xs font-semibold">+ Add</button>
                  </div>
                );
              })()}
            </div>
          );
        })()}
      </div>

      {/* ── Wastage Log Section ───────────────────────────────────────── */}
      <div className="mt-6 border-t border-gray-100 pt-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-bold text-slate-700">Wastage Log</p>
            <p className="text-xs text-gray-400">Record filament lost to testing, prototypes, jams, etc.</p>
          </div>
          <button onClick={()=>setShowWasteForm(p=>!p)}
            className="flex items-center gap-1.5 text-xs font-semibold text-orange-600 border border-orange-200 hover:bg-orange-50 px-3 py-1.5 rounded-lg transition-all">
            {showWasteForm?"✕ Cancel":"+ Record Wastage"}
          </button>
        </div>

        {showWasteForm&&(
          <div className="bg-orange-50/60 border border-orange-100 rounded-xl p-3 space-y-3">
            <p className="text-xs font-semibold text-orange-600 uppercase tracking-wide">New Wastage Entry</p>

            {/* Date + Reason row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold text-gray-500">Date</label>
                <input type="date" value={wasteEntry.date} onChange={e=>updW("date",e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"/>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold text-gray-500">Reason</label>
                <select value={wasteEntry.reason} onChange={e=>updW("reason",e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 bg-white">
                  {WASTE_REASONS.map(r=><option key={r}>{r}</option>)}
                </select>
              </div>
            </div>

            {/* Filament picker */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500">Filament</label>
              {(()=>{
                const groups = {};
                inventory.forEach(i=>{
                  const key=`${i.brand||""}||${i.material}||${i.color||""}`;
                  if(!groups[key]) groups[key]={brand:i.brand,material:i.material,color:i.color,totalWeight:0,totalRemaining:0};
                  groups[key].totalWeight+=Number(i.weightG||0);
                  groups[key].totalRemaining+=getRemainingG(i);
                });
                const matC = {PLA:"bg-green-100 text-green-700",PETG:"bg-blue-100 text-blue-700",ABS:"bg-orange-100 text-orange-700",ASA:"bg-amber-100 text-amber-700",TPU:"bg-purple-100 text-purple-700",Nylon:"bg-cyan-100 text-cyan-700",PC:"bg-slate-100 text-slate-700","PLA+":"bg-emerald-100 text-emerald-700","PLA-CF":"bg-gray-100 text-gray-700","PETG-CF":"bg-indigo-100 text-indigo-700","ABS-CF":"bg-red-100 text-red-700",Resin:"bg-pink-100 text-pink-700",Other:"bg-gray-100 text-gray-500"};
                return (
                  <div className="space-y-1.5">
                    {Object.entries(groups).map(([key,g])=>{
                      const pct=g.totalWeight>0?Math.round(g.totalRemaining/g.totalWeight*100):100;
                      const barC=pct>50?"bg-emerald-400":pct>20?"bg-amber-400":"bg-red-400";
                      const textC=pct>50?"text-emerald-600":pct>20?"text-amber-500":"text-red-500";
                      const isSel=wasteEntry.groupKey===key;
                      return (
                        <button key={key} type="button" onClick={()=>updW("groupKey",isSel?"":key)}
                          className={`w-full text-left rounded-xl px-3 py-2.5 border transition-all ${isSel?"border-orange-400 bg-orange-50 ring-1 ring-orange-300":"border-gray-200 bg-white hover:border-orange-200 hover:bg-orange-50/30"}`}>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-bold shrink-0 ${matC[g.material]||"bg-gray-100 text-gray-600"}`}>{g.material}</span>
                              <span className="text-sm font-semibold text-slate-800 truncate">{g.brand||"No brand"}</span>
                              <span className="text-sm text-gray-400 truncate">— {g.color||"No colour"}</span>
                            </div>
                            <span className={`text-xs font-bold shrink-0 ${textC}`}>{g.totalRemaining.toFixed(0)}g left</span>
                          </div>
                          <div className="mt-1.5 h-1 bg-gray-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${barC}`} style={{width:`${pct}%`}}/>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* Weight + Order row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold text-gray-500">Weight Wasted (g)</label>
                <input type="number" value={wasteEntry.weightG} min="0" step="0.1" placeholder="0.0"
                  onChange={e=>updW("weightG",e.target.value)} onWheel={e=>e.target.blur()}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"/>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold text-gray-500">Linked Order <span className="text-gray-400 font-normal">(optional)</span></label>
                <select value={wasteEntry.orderNo} onChange={e=>updW("orderNo",e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 bg-white">
                  <option value="">— None —</option>
                  {pendingOrders.map(o=>(
                    <option key={o.orderNo} value={o.orderNo}>{o.orderNo} — {o.customerName}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
              <input value={wasteEntry.notes} onChange={e=>updW("notes",e.target.value)} placeholder="e.g. nozzle clog, stringing test…"
                className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"/>
            </div>

            <button onClick={handleAddWaste}
              className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm font-semibold">
              Record Wastage
            </button>
          </div>
        )}

        {/* Wastage list */}
        {wastageLog.length===0&&!showWasteForm&&(
          <p className="text-xs text-gray-400 text-center py-4">No wastage recorded yet.</p>
        )}
        <div className="space-y-2">
          {[...wastageLog].reverse().map(w=>(
            <div key={w.id} className="bg-white border border-orange-100 rounded-xl px-4 py-3 flex items-start justify-between gap-3 hover:shadow-sm transition-all">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs bg-orange-100 text-orange-600 font-bold px-2 py-0.5 rounded-full">{w.reason}</span>
                  <span className="text-sm font-semibold text-slate-700">{w.brand||"No brand"} · {w.material} · {w.color||"No colour"}</span>
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <span className="text-sm font-bold text-orange-600">{Number(w.weightG).toFixed(1)} g</span>
                  <span className="text-xs text-gray-400">{w.date}</span>
                  {w.orderNo&&<span className="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{w.orderNo}</span>}
                  {w.notes&&<span className="text-xs text-gray-400 italic">{w.notes}</span>}
                </div>
              </div>
              <button onClick={()=>setWastageLog(prev=>prev.filter(x=>x.id!==w.id))}
                className="text-red-300 hover:text-red-500 font-bold text-lg leading-none shrink-0">×</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function SettlementForm({ fromId, fromName, net, recipients, allRecipients, seller, summaries, onSettle }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [direction, setDirection] = useState("");
  const [via, setVia] = useState("");
  const [ref, setRef] = useState("");

  const others = summaries.filter(s => s.id !== fromId);
  const companyName = seller?.name || "Company";

  // net > 0: recipient owes company → they pay back
  // net < 0: company owes recipient → company pays them
  const dirOptions = net > 0
    ? [
        { value: "recipientPaysCompany",           label: `${fromName} pays ${companyName} directly` },
        { value: "recipientTransfersToRecipient",   label: `${fromName} transfers to another recipient` },
      ]
    : [
        { value: "companyPaysRecipient",             label: `${companyName} pays ${fromName} directly` },
        { value: "recipientPaysOnBehalfOfCompany",   label: `Another recipient pays ${fromName} on company's behalf` },
      ];

  const needsVia = direction === "recipientTransfersToRecipient" || direction === "recipientPaysOnBehalfOfCompany";

  const handleSettle = () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0 || !direction) return;
    if (needsVia && !via) return;
    onSettle({ id: "STL-" + Date.now(), date, amount: amt, ref, fromId, via: needsVia ? via : "__company__", direction });
    setAmount(""); setRef(""); setDirection(""); setVia(""); setOpen(false);
  };

  if (!open) return (
    <button onClick={() => setOpen(true)}
      className="w-full mt-1 text-xs border border-dashed border-indigo-300 text-indigo-500 hover:bg-indigo-50 py-2 rounded-lg font-semibold transition-all">
      + Record Settlement
    </button>
  );

  return (
    <div className="border border-indigo-100 bg-indigo-50/60 rounded-xl p-3 space-y-3 mt-1">
      <p className="text-xs font-bold text-indigo-700 uppercase tracking-wide">Record Settlement</p>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold text-gray-500">Settlement Type</label>
        <select value={direction} onChange={e => { setDirection(e.target.value); setVia(""); }}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
          <option value="">— Select type —</option>
          {dirOptions.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </div>

      {needsVia && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold text-gray-500">
            {direction === "recipientTransfersToRecipient" ? "Transfer to…" : "Paying recipient…"}
          </label>
          <select value={via} onChange={e => setVia(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
            <option value="">— Select recipient —</option>
            {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold text-gray-500">Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"/>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold text-gray-500">Amount (₹)</label>
          <input type="number" value={amount} min="0" placeholder="0.00"
            onChange={e => setAmount(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"/>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold text-gray-500">Ref / Note (optional)</label>
        <input value={ref} onChange={e => setRef(e.target.value)} placeholder="UPI ref, bank transfer…"
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"/>
      </div>

      <div className="flex gap-2">
        <button onClick={handleSettle}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg text-xs font-semibold">
          Save
        </button>
        <button onClick={() => setOpen(false)}
          className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-3 py-1.5 rounded-lg text-xs">
          Cancel
        </button>
      </div>
    </div>
  );
}

function Dashboard({ orders, expenses, recipients, allRecipients=[], seller, settlements=[], setSettlements=()=>{} }) {
  // Build per-recipient ledger
  // Each recipient either:
  //   collected money (advance/payments) → recipient owes company (positive = recipient owes)
  //   paid expenses                      → company owes recipient (positive = company owes)
  // net = totalExpenses - totalCollected
  //   positive → company owes recipient
  //   negative → recipient owes company

  const resolveRecipientName = (id) => {
    if (!id) return null;
    if (id === "__company__") return seller?.name || "Company";
    // Search active recipients first, then fall back to allRecipientsRef (deleted ones)
    const r = recipients.find(r => r.id === id) || allRecipients.find(r => r.id === id);
    return r ? r.name : id;
  };

  // Gather all recipient IDs (excluding company)
  const allIds = new Set();
  orders.forEach(o => {
    if (o.advanceRecipient && o.advanceRecipient !== "__company__") allIds.add(o.advanceRecipient);
    (o.payments || []).forEach(p => { if (p.receivedBy && p.receivedBy !== "__company__") allIds.add(p.receivedBy); });
  });
  expenses.forEach(e => { if (e.paidBy && e.paidBy !== "__company__") allIds.add(e.paidBy); });

  // Build ledger per recipient
  const ledger = {};
  const addEntry = (id, amount, type, label, date, ref) => {
    if (!ledger[id]) ledger[id] = { collected: [], expenses: [], settlements: [] };
    ledger[id][type].push({ amount: num(amount), label, date, ref });
  };

  orders.forEach(o => {
    if (o.advanceRecipient && o.advanceRecipient !== "__company__" && num(o.advance) > 0) {
      addEntry(o.advanceRecipient, o.advance, "collected", `Advance — ${o.customerName} (${o.orderNo})`, o.orderDate, o.orderNo);
    }
    (o.payments || []).forEach(p => {
      if (p.receivedBy && p.receivedBy !== "__company__" && num(p.amount) > 0) {
        addEntry(p.receivedBy, p.amount, "collected", `Payment — ${o.customerName} (${o.orderNo})`, p.date, p.txnRef || "");
      }
    });
  });

  expenses.forEach(e => {
    if (e.paidBy && e.paidBy !== "__company__" && num(e.amount) > 0) {
      addEntry(e.paidBy, e.amount, "expenses", `${e.category}${e.comment ? " — " + e.comment : ""}`, e.date, "");
    }
  });

  // Process settlements
  // st.direction: "recipientPaysCompany" | "companyPaysRecipient" | "recipientTransfersToRecipient" | "recipientPaysViaRecipient"
  const companyName = seller?.name || "Company";
  settlements.forEach(st => {
    const amt = num(st.amount);
    if (!amt) return;
    const fromName = resolveRecipientName(st.fromId);
    const viaName = resolveRecipientName(st.via);
    if (!ledger[st.fromId]) ledger[st.fromId] = { collected: [], expenses: [], settlements: [] };

    if (st.direction === "recipientPaysCompany") {
      // Recipient owes company → pays company directly → clears their debt
      ledger[st.fromId].settlements.push({ amount: amt, label: `Paid company directly`, date: st.date, ref: st.ref, stId: st.id });
      ledger[st.fromId].collected.push({ amount: -amt, label: `Settlement — paid company`, date: st.date, ref: st.ref });

    } else if (st.direction === "companyPaysRecipient") {
      // Company owes recipient → company pays them directly → clears company's debt
      ledger[st.fromId].settlements.push({ amount: amt, label: `Company paid directly`, date: st.date, ref: st.ref, stId: st.id });
      ledger[st.fromId].expenses.push({ amount: -amt, label: `Settlement — company paid`, date: st.date, ref: st.ref });

    } else if (st.direction === "recipientTransfersToRecipient") {
      // Recipient A owes company → transfers to Recipient B → B now owes company instead
      const viaId = st.via;
      if (!ledger[viaId]) ledger[viaId] = { collected: [], expenses: [], settlements: [] };
      ledger[st.fromId].settlements.push({ amount: amt, label: `Transferred to ${viaName}`, date: st.date, ref: st.ref, stId: st.id });
      ledger[st.fromId].collected.push({ amount: -amt, label: `Transfer to ${viaName}`, date: st.date, ref: st.ref });
      ledger[viaId].collected.push({ amount: amt, label: `Transfer received from ${fromName}`, date: st.date, ref: st.ref });
      ledger[viaId].settlements.push({ amount: amt, label: `Received from ${fromName} (owed company)`, date: st.date, ref: st.ref, stId: st.id });

    } else if (st.direction === "recipientPaysOnBehalfOfCompany") {
      // Company owes Recipient A → Recipient B pays A on company's behalf → company now owes B instead
      const viaId = st.via;
      if (!ledger[viaId]) ledger[viaId] = { collected: [], expenses: [], settlements: [] };
      ledger[st.fromId].settlements.push({ amount: amt, label: `${viaName} paid on company's behalf`, date: st.date, ref: st.ref, stId: st.id });
      ledger[st.fromId].expenses.push({ amount: -amt, label: `Settled by ${viaName}`, date: st.date, ref: st.ref });
      ledger[viaId].expenses.push({ amount: amt, label: `Paid ${fromName} on company's behalf`, date: st.date, ref: st.ref });
      ledger[viaId].settlements.push({ amount: amt, label: `Paid ${fromName} on company's behalf`, date: st.date, ref: st.ref, stId: st.id });

    }
  });

  const summaries = [...allIds].map(id => {
    const l = ledger[id] || { collected: [], expenses: [], settlements: [] };
    const totalCollected = l.collected.reduce((s, x) => s + x.amount, 0);
    const totalExpenses = l.expenses.reduce((s, x) => s + x.amount, 0);
    const net = totalCollected - totalExpenses; // +ve = recipient owes company, -ve = company owes recipient
    return { id, name: resolveRecipientName(id) || id, totalCollected, totalExpenses, net, entries: l };
  }).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  const [expanded, setExpanded] = useState(null);

  const companyOwes = summaries.filter(s=>s.net<0).reduce((s,x)=>s+Math.abs(x.net),0);
  const recipientsOwe = summaries.filter(s=>s.net>0).reduce((s,x)=>s+x.net,0);

  return (
    <div className="space-y-6">
      {/* Header summary */}
      <div className="flex justify-end">
        <ExcelBtn onClick={()=>{
          const rows = [];
          summaries.forEach(s=>{
            [...s.entries.collected.map(e=>({...e,entryType:"Collected"})), ...s.entries.expenses.map(e=>({...e,entryType:"Expense"}))]
              .sort((a,b)=>(b.date||"").localeCompare(a.date||""))
              .forEach(e=>rows.push({
                "Recipient": s.name,
                "Type": e.entryType,
                "Date": e.date||"",
                "Amount (₹)": e.amount,
                "Description": e.label||"",
                "Ref": e.ref||"",
              }));
          });
          exportToExcel(rows, "Splitwise_Export");
        }}/>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-orange-50 border border-orange-100 rounded-xl px-5 py-4">
          <p className="text-xs text-orange-400 uppercase tracking-wide font-semibold mb-1">Company Owes Recipients</p>
          <p className="text-2xl font-black text-orange-600">₹{fmt(companyOwes)}</p>
        </div>
        <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-5 py-4">
          <p className="text-xs text-emerald-500 uppercase tracking-wide font-semibold mb-1">Recipients Owe Company</p>
          <p className="text-2xl font-black text-emerald-600">₹{fmt(recipientsOwe)}</p>
        </div>
      </div>

      {summaries.length === 0 && (
        <p className="text-gray-400 text-sm text-center py-12">No data yet. Record payments or expenses with non-company recipients to see the dashboard.</p>
      )}

      {/* Per-recipient cards */}
      <div className="space-y-3">
        {summaries.map(s => {
          const isOpen = expanded === s.id;
          const allEntries = [
            ...s.entries.collected.map(e => ({...e, type:"collected"})),
            ...s.entries.expenses.map(e => ({...e, type:"expense"})),
          ].sort((a,b) => b.date?.localeCompare(a.date || "") || 0);

          return (
            <div key={s.id} className="border border-gray-100 rounded-xl bg-white overflow-hidden">
              {/* Summary row */}
              <div className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 transition-all" onClick={() => setExpanded(isOpen ? null : s.id)}>
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-sm font-bold shrink-0">
                    {s.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-800">{s.name}</p>
                    <p className="text-xs text-gray-400">{s.entries.collected.length} collection{s.entries.collected.length!==1?"s":""} · {s.entries.expenses.length} expense{s.entries.expenses.length!==1?"s":""}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-xs text-gray-400">{s.net>0?"Recipient owes company":s.net<0?"Company owes":"Settled"}</p>
                    <p className={`text-sm font-bold ${s.net>0?"text-emerald-600":s.net<0?"text-orange-500":"text-gray-400"}`}>₹{fmt(Math.abs(s.net))}</p>
                  </div>
                  <span className="text-gray-300">{isOpen ? "▲" : "▼"}</span>
                </div>
              </div>

              {/* Expanded breakdown */}
              {isOpen && (
                <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-3">
                  {/* Mini summary */}
                  <div className="grid grid-cols-2 gap-2 mb-1">
                    <div className="bg-emerald-50 rounded-lg px-3 py-2">
                      <p className="text-xs text-emerald-500 mb-0.5">Collected (owes company)</p>
                      <p className="text-sm font-bold text-emerald-700">₹{fmt(s.totalCollected)}</p>
                    </div>
                    <div className="bg-orange-50 rounded-lg px-3 py-2">
                      <p className="text-xs text-orange-400 mb-0.5">Expenses paid (company owes)</p>
                      <p className="text-sm font-bold text-orange-600">₹{fmt(s.totalExpenses)}</p>
                    </div>
                  </div>

                  {/* Entry list */}
                  <div className="space-y-1.5">
                    {allEntries.map((e, i) => (
                      <div key={i} className="flex items-start justify-between gap-3 bg-gray-50 rounded-lg px-3 py-2">
                        <div className="flex items-start gap-2 min-w-0">
                          <span className={`mt-0.5 text-xs px-1.5 py-0.5 rounded font-semibold shrink-0 ${e.type==="collected"?"bg-blue-100 text-blue-700":"bg-red-100 text-red-600"}`}>
                            {e.type==="collected"?"💰":"💸"}
                          </span>
                          <div className="min-w-0">
                            <p className="text-xs text-gray-700 font-medium leading-tight">{e.label}</p>
                            <p className="text-xs text-gray-400">{e.date}{e.ref ? ` · ${e.ref}` : ""}</p>
                          </div>
                        </div>
                        <span className="text-xs font-bold text-slate-700 shrink-0">₹{fmt(e.amount)}</span>
                      </div>
                    ))}
                  </div>

                  {/* Settlements for this recipient */}
                  {s.entries.settlements.length>0&&(
                    <div className="space-y-1 pt-1">
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Settlements</p>
                      {s.entries.settlements.map((st,si)=>(
                        <div key={si} className="flex items-center justify-between gap-2 bg-violet-50 rounded-lg px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-violet-800">{st.label}</p>
                            <p className="text-xs text-gray-400">{st.date}{st.ref?` · ${st.ref}`:""}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-xs font-bold text-violet-700">₹{fmt(st.amount)}</span>
                            <button onClick={()=>setSettlements(prev=>prev.filter(x=>x.id!==st.stId))} className="text-red-400 hover:text-red-600 text-sm font-bold leading-none">×</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">
                      {s.net>0?`${s.name} owes company`:s.net<0?`Company owes ${s.name}`:"Settled"}
                    </span>
                    <span className={`text-sm font-black ${s.net>0?"text-emerald-600":s.net<0?"text-orange-500":"text-gray-400"}`}>
                      {s.net===0?"✓ Settled":`₹${fmt(Math.abs(s.net))}`}
                    </span>
                  </div>

                  {/* Record a settlement */}
                  <SettlementForm
                    fromId={s.id}
                    fromName={s.name}
                    net={s.net}
                    recipients={recipients}
                    allRecipients={allRecipients}
                    seller={seller}
                    summaries={summaries}
                    onSettle={(settlement)=>{
                      setSettlements(prev=>[...prev, settlement]);
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Supabase Client ──────────────────────────────────────────────────────────
function createSupabaseClient(url, key) {
  const headers = { "Content-Type": "application/json", "apikey": key, "Authorization": `Bearer ${key}` };
  const rest = `${url}/rest/v1`;

  const from = (table) => ({
    select: async (cols="*") => {
      const r = await fetch(`${rest}/${table}?select=${cols}&order=created_at.asc`, { headers: {...headers, "Prefer":"return=representation"} });
      if (!r.ok) return [];
      return r.json();
    },
    upsert: async (rowOrRows) => {
      const r = await fetch(`${rest}/${table}`, {
        method: "POST",
        headers: {...headers, "Prefer":"resolution=merge-duplicates,return=minimal"},
        body: JSON.stringify(rowOrRows)
      });
      return r.ok;
    },
    delete: async (col, val) => {
      const r = await fetch(`${rest}/${table}?${col}=eq.${encodeURIComponent(val)}`, {
        method: "DELETE", headers
      });
      return r.ok;
    },
    deleteMany: async (col, vals) => {
      if (!vals?.length) return true;
      const list = vals.map(v=>encodeURIComponent(v)).join(",");
      const r = await fetch(`${rest}/${table}?${col}=in.(${list})`, {
        method: "DELETE", headers
      });
      return r.ok;
    }
  });
  const auth = {
    signIn: async (email, password) => {
      const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": key },
        body: JSON.stringify({ email, password })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error_description || data.msg || "Login failed");
      return data; // { access_token, refresh_token, user }
    },
    signOut: async (accessToken) => {
      await fetch(`${url}/auth/v1/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": key, "Authorization": `Bearer ${accessToken}` }
      });
    },
    getUser: async (accessToken) => {
      const r = await fetch(`${url}/auth/v1/user`, {
        headers: { "apikey": key, "Authorization": `Bearer ${accessToken}` }
      });
      return r.ok ? r.json() : null;
    }
  };
  return { from, auth };
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin, sbUrl, sbKey }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async () => {
    if (!email || !password) { setError("Please enter email and password"); return; }
    if (!sbUrl || !sbKey) { setError("Supabase credentials not configured. Check your environment variables."); return; }
    setLoading(true); setError("");
    try {
      const client = createSupabaseClient(sbUrl, sbKey);
      const data = await client.auth.signIn(email, password);

      onLogin(data.access_token, data.user);
    } catch(e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-slate-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 space-y-6">
          <div className="text-center">
            <div className="text-4xl mb-3">🧾</div>
            <h1 className="text-2xl font-black text-slate-800">Elace Business Management</h1>
            <p className="text-sm text-gray-400 mt-1">Sign in to continue</p>
          </div>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 block mb-1">Email</label>
              <input
                type="email" value={email} onChange={e=>setEmail(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&handleLogin()}
                placeholder="you@example.com"
                className="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white text-slate-800"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wide text-gray-500 block mb-1">Password</label>
              <input
                type="password" value={password} onChange={e=>setPassword(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&handleLogin()}
                placeholder="••••••••"
                className="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white text-slate-800"
              />
            </div>
            {error&&<p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
            <button
              onClick={handleLogin} disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg text-sm transition-all"
            >
              {loading ? "Signing in…" : "Sign In"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
// ─── Toast Notification ───────────────────────────────────────────────────────
function Toast({ toasts }) {
  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className={`flex items-center gap-3 px-5 py-3 rounded-xl shadow-lg text-sm font-semibold transition-all duration-300
          ${t.type==="error" ? "bg-red-600 text-white" : "bg-slate-800 text-white"}`}>
          <span>{t.type==="error" ? "✕" : "✓"}</span>
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Bulk Download ────────────────────────────────────────────────────────────
function BulkDownload({ orders=[], quotations=[], proformas=[], taxInvoices=[], seller={} }) {
  const thisMonth = new Date().toISOString().slice(0,7);
  const threeMonthsAgo = (()=>{ const d=new Date(); d.setMonth(d.getMonth()-2); return d.toISOString().slice(0,7); })();
  const [from, setFrom] = useState(threeMonthsAgo);
  const [to, setTo] = useState(thisMonth);
  const [custTypes, setCustTypes] = useState(['B2B','B2C']);        // B2B / B2C
  const [orderStatuses, setOrderStatuses] = useState(['Pending','Completed','Cancelled']); // status filter
  const [balanceFilter, setBalanceFilter] = useState('all');         // all / no_balance / has_balance
  const [docTypes, setDocTypes] = useState(['quotation','proforma','tax']); // which doc types to include
  const [status, setStatus] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState({done:0,total:0});

  const MONTH_NAMES = {'01':'01-Jan','02':'02-Feb','03':'03-Mar','04':'04-Apr','05':'05-May','06':'06-Jun','07':'07-Jul','08':'08-Aug','09':'09-Sep','10':'10-Oct','11':'11-Nov','12':'12-Dec'};

  const inRange = (dateStr) => { if (!dateStr) return false; const ym=dateStr.slice(0,7); return ym>=from&&ym<=to; };
  const getOrder = (inv) => orders.find(o=>o.orderNo===inv.orderId)||{};

  const getOrderBalance = (order) => {
    const tiTotal = taxInvoices.filter(t=>t.orderId===order.orderNo).reduce((s,t)=>s+(t.amount||t.items?.reduce((a,i)=>a+num(i.netAmt),0)||0),0);
    const qtTotal = quotations.filter(q=>q.orderId===order.orderNo).reduce((s,q)=>s+(q.amount||0),0);
    const orderTotal = tiTotal>0?tiTotal:qtTotal;
    const totalPaid = (order.payments||[]).reduce((s,p)=>s+num(p.amount),0)+num(order.advance);
    return orderTotal - totalPaid;
  };

  const orderPassesFilters = (order) => {
    if (!order.orderNo) return false;
    if (!custTypes.includes(order.type==='B2B'?'B2B':'B2C')) return false;
    if (!orderStatuses.includes(order.status||'Pending')) return false;
    if (balanceFilter==='no_balance' && getOrderBalance(order)>0.01) return false;
    if (balanceFilter==='has_balance' && getOrderBalance(order)<=0.01) return false;
    return true;
  };

  const qtFiltered  = docTypes.includes('quotation') ? quotations.filter(q=>inRange(q.invDate)&&orderPassesFilters(getOrder(q))) : [];
  const pfFiltered  = docTypes.includes('proforma')  ? proformas.filter(p=>inRange(p.invDate)&&orderPassesFilters(getOrder(p))) : [];
  const tiFiltered  = docTypes.includes('tax')       ? taxInvoices.filter(t=>inRange(t.invDate)&&orderPassesFilters(getOrder(t))) : [];
  const total = qtFiltered.length+pfFiltered.length+tiFiltered.length;

  // Folder preview tree
  const tree = {};
  const addToTree = (inv, type) => {
    const order=getOrder(inv); const ct=order.type==='B2B'?'B2B':'B2C';
    const year=(inv.invDate||'').slice(0,4)||'Unknown';
    const month=MONTH_NAMES[(inv.invDate||'').slice(5,7)]||(inv.invDate||'').slice(5,7)||'Unknown';
    const k=`${ct}|||${year}|||${month}`;
    if(!tree[k]) tree[k]={ct,year,month,qt:0,pf:0,ti:0};
    tree[k][type]++;
  };
  qtFiltered.forEach(q=>addToTree(q,'qt'));
  pfFiltered.forEach(p=>addToTree(p,'pf'));
  tiFiltered.forEach(t=>addToTree(t,'ti'));
  const treeEntries=Object.values(tree).sort((a,b)=>`${a.ct}${a.year}${a.month}`>`${b.ct}${b.year}${b.month}`?1:-1);

  const toggleArr = (arr, setArr, val) => arr.includes(val) ? setArr(arr.filter(x=>x!==val)) : setArr([...arr, val]);
  const chipCls = (active) => `px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer select-none ${active?'bg-indigo-600 border-indigo-600 text-white':'border-gray-200 text-gray-500 hover:border-indigo-300 hover:text-indigo-600'}`;

  const loadScript = (url) => new Promise((res,rej)=>{
    if (document.querySelector(`script[src="${url}"]`)) { res(); return; }
    const s=document.createElement('script'); s.src=url;
    s.onload=res; s.onerror=()=>rej(new Error('Failed to load '+url));
    document.head.appendChild(s);
  });

  const htmlToPdfBlob = (html) => new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1080px;height:1px;border:none;visibility:hidden;';
    document.body.appendChild(iframe);
    const cleanup = () => { try { document.body.removeChild(iframe); } catch(e){} };
    iframe.onload = async () => {
      try {
        await new Promise(r=>setTimeout(r,300));
        const doc=iframe.contentDocument, body=doc.body, htmlEl=doc.documentElement;
        const fullH=Math.max(body.scrollHeight,body.offsetHeight,htmlEl.scrollHeight,htmlEl.offsetHeight);
        iframe.style.height=fullH+'px';
        await new Promise(r=>setTimeout(r,100));
        const canvas=await window.html2canvas(body,{scale:2,useCORS:true,allowTaint:true,width:1080,height:fullH,scrollX:0,scrollY:0,windowWidth:1080,windowHeight:fullH,backgroundColor:'#ffffff',logging:false});
        const {jsPDF}=window.jspdf;
        const imgW=210, imgH=(canvas.height*imgW)/canvas.width;
        const pdf=new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});
        let y=0, pageH=297;
        while(y<imgH){
          if(y>0) pdf.addPage();
          const srcY=Math.round((y/imgH)*canvas.height), srcH=Math.round((Math.min(pageH,imgH-y)/imgH)*canvas.height);
          const slice=document.createElement('canvas'); slice.width=canvas.width; slice.height=srcH;
          slice.getContext('2d').drawImage(canvas,0,srcY,canvas.width,srcH,0,0,canvas.width,srcH);
          pdf.addImage(slice.toDataURL('image/jpeg',0.92),'JPEG',0,0,imgW,Math.min(pageH,imgH-y));
          y+=pageH;
        }
        cleanup(); resolve(pdf.output('blob'));
      } catch(e){ cleanup(); reject(e); }
    };
    iframe.onerror=(e)=>{cleanup();reject(e);};
    iframe.srcdoc=html;
  });

  const handleDownload = async () => {
    if (total===0) { setStatus('No invoices match the filters.'); return; }
    setDownloading(true); setProgress({done:0,total});
    try {
      setStatus('Loading libraries…');
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
      const zip=new window.JSZip(); let done=0;
      const addPdf = async (inv, docType, html) => {
        const order=getOrder(inv), ct=order.type==='B2B'?'B2B':'B2C';
        const year=(inv.invDate||'').slice(0,4)||'Unknown';
        const month=MONTH_NAMES[(inv.invDate||'').slice(5,7)]||(inv.invDate||'').slice(5,7)||'Unknown';
        const folder=docType==='quotation'?'Quotations':docType==='proforma'?'Proforma Invoices':'Tax Invoices';
        const filename=(inv.invNo||'invoice').replace(/[/\\:*?"<>|]/g,'-');
        const pdfBlob=await htmlToPdfBlob(html);
        zip.file(`${ct}/${year}/${month}/${folder}/${filename}.pdf`,pdfBlob);
        done++; setProgress({done,total}); setStatus(`Converting ${done}/${total} — ${inv.invNo}`);
      };
      for (const q of qtFiltered) await addPdf(q,'quotation',buildQuotationHtml(getOrder(q),q,seller));
      for (const p of pfFiltered) await addPdf(p,'proforma',buildInvoiceHtml(getOrder(p),p,'proforma',seller));
      for (const t of tiFiltered) await addPdf(t,'tax',buildInvoiceHtml(getOrder(t),t,'tax',seller));
      setStatus('Compressing…');
      const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}},(meta)=>setStatus(`Compressing ${Math.round(meta.percent)}%…`));
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); a.href=url; a.download=`Invoices_${from}_to_${to}.zip`; a.click();
      URL.revokeObjectURL(url);
      setStatus(`✓ ${done} PDFs downloaded`);
    } catch(e) {
      console.error(e); setStatus('Error: '+(e.message||'Download failed'));
    } finally { setDownloading(false); }
  };

  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <p className="text-sm font-bold text-slate-700">Bulk Invoice Download</p>
        <p className="text-xs text-gray-400 mt-0.5">Download filtered invoices as PDFs inside a structured ZIP.</p>
      </div>

      {/* ── Period ── */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Period</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">From</label>
            <input type="month" value={from} onChange={e=>setFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">To</label>
            <input type="month" value={to} onChange={e=>setTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[
            ['This month',()=>{setFrom(thisMonth);setTo(thisMonth);}],
            ['Last 3 months',()=>{const d=new Date();d.setMonth(d.getMonth()-2);setFrom(d.toISOString().slice(0,7));setTo(thisMonth);}],
            ['This year',()=>{setFrom(new Date().getFullYear()+'-01');setTo(thisMonth);}],
            ['Last year',()=>{const y=new Date().getFullYear()-1;setFrom(`${y}-01`);setTo(`${y}-12`);}],
          ].map(([label,fn])=>(
            <button key={label} onClick={fn} className="text-xs text-indigo-600 border border-indigo-200 hover:bg-indigo-50 px-2.5 py-1 rounded-lg font-medium">{label}</button>
          ))}
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Filters</p>

        {/* Customer type */}
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-gray-600">Customer Type</p>
          <div className="flex gap-2">
            {['B2B','B2C'].map(v=>(
              <button key={v} onClick={()=>toggleArr(custTypes,setCustTypes,v)} className={chipCls(custTypes.includes(v))}>{v}</button>
            ))}
          </div>
        </div>

        {/* Order status */}
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-gray-600">Order Status</p>
          <div className="flex flex-wrap gap-2">
            {['Pending','Completed','Cancelled'].map(v=>(
              <button key={v} onClick={()=>toggleArr(orderStatuses,setOrderStatuses,v)} className={chipCls(orderStatuses.includes(v))}>{v}</button>
            ))}
          </div>
        </div>

        {/* Balance filter */}
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-gray-600">Payment Status</p>
          <div className="flex flex-wrap gap-2">
            {[['all','All orders'],['no_balance','No balance due'],['has_balance','Balance pending']].map(([v,label])=>(
              <button key={v} onClick={()=>setBalanceFilter(v)} className={chipCls(balanceFilter===v)}>{label}</button>
            ))}
          </div>
        </div>

        {/* Document types */}
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-gray-600">Document Types</p>
          <div className="flex flex-wrap gap-2">
            {[['quotation','Quotations'],['proforma','Proforma'],['tax','Tax Invoices']].map(([v,label])=>(
              <button key={v} onClick={()=>toggleArr(docTypes,setDocTypes,v)} className={chipCls(docTypes.includes(v))}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Preview ── */}
      {total>0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{total} invoice{total!==1?'s':''} matched — folder preview</p>
          <div className="bg-white border border-gray-100 rounded-xl p-4 font-mono text-xs space-y-1 max-h-52 overflow-y-auto">
            <p className="text-gray-400 mb-1">📦 Invoices_{from}_to_{to}.zip</p>
            {treeEntries.map((node,ni)=>(
              <div key={ni} className="ml-2">
                <p className="text-slate-600 font-semibold">📁 {node.ct} / {node.year} / {node.month}</p>
                {node.qt>0&&<p className="ml-4 text-gray-400">📁 Quotations ({node.qt})</p>}
                {node.pf>0&&<p className="ml-4 text-gray-400">📁 Proforma Invoices ({node.pf})</p>}
                {node.ti>0&&<p className="ml-4 text-gray-400">📁 Tax Invoices ({node.ti})</p>}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-gray-50 border border-gray-100 rounded-xl p-8 text-center">
          <p className="text-sm text-gray-400">No invoices match the current filters.</p>
          <p className="text-xs text-gray-300 mt-1">Adjust the period or filters above.</p>
        </div>
      )}

      {/* ── Progress bar ── */}
      {downloading&&progress.total>0&&(
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-500">
            <span className="truncate mr-2">{status}</span>
            <span className="shrink-0">{progress.done}/{progress.total}</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-indigo-500 rounded-full transition-all duration-300"
              style={{width:`${Math.round((progress.done/progress.total)*100)}%`}}/>
          </div>
        </div>
      )}

      {/* ── Download button ── */}
      <div className="flex items-center gap-3">
        <button onClick={handleDownload} disabled={downloading||total===0}
          className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-all">
          {downloading?'Converting…':`⬇ Download PDFs (${total})`}
        </button>
        {!downloading&&status&&(
          <span className={`text-xs font-medium ${status.startsWith('✓')?'text-emerald-600':status.startsWith('Error')?'text-red-500':'text-indigo-500'}`}>{status}</span>
        )}
      </div>

      <p className="text-xs text-gray-400 border-t border-gray-100 pt-3">Each invoice is rendered and converted to PDF client-side. Keep this tab open during conversion.</p>
    </div>
  );
}

function App() {
  const [tab,setTab]=useState("new");
  const [viewOrder,setViewOrder]=useState(null);
  const [accessToken,setAccessToken]=useState(()=>sessionStorage.getItem("sb_token")||"");
  const accessTokenRef = useRef(accessToken);
  const [user,setUser]=useState(null);
  const [orders,setOrders]=useState([]);
  const [quotations,setQuotations]=useState([]);
  const [proformas,setProformas]=useState([]);
  const [taxInvoices,setTaxInvoices]=useState([]);
  const [clients,setClients]=useState([]);
  const [recipients,setRecipients]=useState([]);
  const allRecipientsRef = useRef([]); // keeps deleted recipients for name resolution
  const [expenses,setExpenses]=useState([]);
  const [seller,setSeller]=useState(DEFAULT_SELLER);
  const [series,setSeries]=useState(DEFAULT_SERIES);
  const [loading,setLoading]=useState(false);
  const [syncStatus,setSyncStatus]=useState("");
  const [toasts,setToasts]=useState([]);
  const toast = (msg, type="success") => {
    const id = Date.now();
    setToasts(p=>[...p,{id,msg,type}]);
    setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)), 3000);
  };
  const ENV_URL = getEnv("VITE_SUPABASE_URL");
  const ENV_KEY = getEnv("VITE_SUPABASE_KEY");
  const [sbUrl,setSbUrl]=useState(()=>localStorage.getItem("sb_url")||ENV_URL);
  const [sbKey,setSbKey]=useState(()=>localStorage.getItem("sb_key")||ENV_KEY);
  const [assets,setAssets]=useState([]);
  const [inventory,setInventory]=useState([]);
  const [settlements,setSettlements]=useState([]);
  const [wastageLog,setWastageLog]=useState([]);
  const [products,setProducts]=useState([]);
  const cdnCloud = getEnv("VITE_CLOUDINARY_CLOUD")||"";
  const cdnPreset = getEnv("VITE_CLOUDINARY_PRESET")||"";
  const syncQueue = useRef([]);
  const syncing = useRef(false);
  const sbRef = useRef(null);

  // ── Init supabase client whenever credentials change ────────────────────
  useEffect(()=>{
    if (sbUrl && sbKey) sbRef.current = createSupabaseClient(sbUrl, sbKey);
  },[sbUrl, sbKey]);

  // Keep accessToken ref in sync with state
  useEffect(()=>{ accessTokenRef.current = accessToken; },[accessToken]);

  const sb = () => {
    // Override Authorization header with user's access token when logged in
    if (!sbRef.current) return null;
    const token = accessTokenRef.current || accessToken;
    if (!token) return sbRef.current;
    const client = createSupabaseClient(sbUrl, sbKey);
    // Patch headers with user token
    const origFrom = client.from.bind(client);
    client._token = accessToken;
    const patchedHeaders = (h) => ({...h, "Authorization": `Bearer ${accessToken}`});
    const rest = `${sbUrl}/rest/v1`;
    const headers = { "Content-Type": "application/json", "apikey": sbKey, "Authorization": `Bearer ${token}` };
    client.from = (table) => ({
      select: async (cols="*") => {
        const r = await fetch(`${rest}/${table}?select=${cols}&order=created_at.asc`, { headers: {...headers, "Prefer":"return=representation"} });
        if (!r.ok) return [];
        return r.json();
      },
      upsert: async (rowOrRows) => {
        const r = await fetch(`${rest}/${table}`, { method:"POST", headers:{...headers,"Prefer":"resolution=merge-duplicates,return=minimal"}, body:JSON.stringify(rowOrRows) });
        return r.ok;
      },
      delete: async (col, val) => {
        const r = await fetch(`${rest}/${table}?${col}=eq.${encodeURIComponent(val)}`, { method:"DELETE", headers });
        return r.ok;
      },
      deleteMany: async (col, vals) => {
        if (!vals?.length) return true;
        const list = vals.map(v=>encodeURIComponent(v)).join(",");
        const r = await fetch(`${rest}/${table}?${col}=in.(${list})`, { method:"DELETE", headers });
        return r.ok;
      }
    });
    return client;
  };

  // ── Load all data on mount ───────────────────────────────────────────────
  useEffect(()=>{
    const ENV_URL2 = getEnv("VITE_SUPABASE_URL");
    const ENV_KEY2 = getEnv("VITE_SUPABASE_KEY");
    const url = localStorage.getItem("sb_url")||ENV_URL2;
    const key = localStorage.getItem("sb_key")||ENV_KEY2;
    const token = sessionStorage.getItem("sb_token")||"";
    if (!url||!key||!token) return;
    const baseClient = createSupabaseClient(url, key);
    const authHeaders = { "Content-Type": "application/json", "apikey": key, "Authorization": `Bearer ${token}` };
    const rest2 = `${url}/rest/v1`;
    const client = { from: (table) => ({
      select: async (cols="*") => {
        const r = await fetch(`${rest2}/${table}?select=${cols}&order=created_at.asc`, { headers: {...authHeaders,"Prefer":"return=representation"} });
        if (!r.ok) return [];
        return r.json();
      }
    }), auth: baseClient.auth };
    // brace balance fixed
    setLoading(true);
    Promise.all([
      client.from("orders").select(),
      client.from("quotations").select(),
      client.from("proformas").select(),
      client.from("tax_invoices").select(),
      client.from("items").select(),
      client.from("clients").select(),
      client.from("recipients").select(),
      client.from("expenses").select(),
      client.from("payments").select(),
      client.from("assets").select(),
      client.from("settings").select(),
      client.from("settlements").select(),
      client.from("inventory").select(),
      client.from("wastage_log").select(),
      client.from("products").select(),
    ]).then(([ord,qt,pf,ti,allItems,cl,rc,ex,pay,ass,sets,stl,inv,wlog,prods])=>{
      const parseJson = (v) => { if (typeof v==="string" && (v.startsWith("{")||v.startsWith("["))) { try{return JSON.parse(v)}catch(e){return v} } return v; };
      // Map DB item row to app item object
      const mapItem = (r) => ({ sl:r.sl, item:r.item||"", hsn:r.hsn||"", unit:r.unit||"Nos", unitPrice:r.unit_price, qty:r.qty, discount:r.discount, grossAmt:r.gross_amt, cgstRate:r.cgst_rate, cgstAmt:r.cgst_amt, sgstRate:r.sgst_rate, sgstAmt:r.sgst_amt, netAmt:r.net_amt, _brand:r.brand||"", _material:r.material||"", _productId:r.product_id||"" });
      const getItems = (type, id) => (allItems||[]).filter(i=>i.document_type===type&&i.document_id===id).sort((a,b)=>a.sl-b.sl).map(mapItem);
      const mapOrder = (r) => ({ orderNo:r.order_no, orderNoBase:r.order_no_base, type:r.type, customerName:r.customer_name, phone:r.phone, email:r.email, gstin:r.gstin, billingName:r.billing_name, billingAddress:r.billing_address, billingStateCode:r.billing_state_code, shippingName:r.shipping_name, shippingAddress:r.shipping_address, shippingContact:r.shipping_contact, shippingGstin:r.shipping_gstin, shippingStateCode:r.shipping_state_code, placeOfSupply:r.place_of_supply, orderDate:r.order_date, dueDate:r.due_date, paymentMode:r.payment_mode, advance:r.advance, advanceRecipient:r.advance_recipient, advanceTxnRef:r.advance_txn_ref, status:r.status, comments:r.comments, needsGst:r.needs_gst, quotationNo:r.quotation_no, proformaIds:parseJson(r.proforma_ids)||[], taxInvoiceIds:parseJson(r.tax_invoice_ids)||[], filamentUsage:(v=>Array.isArray(v)?v:[])(parseJson(r.filament_usage)), charges:(v=>Array.isArray(v)?v:[])(parseJson(r.charges)), items:getItems("order",r.order_no), payments:[] });
      const mapInv = (type) => (r) => ({ invNo:r.inv_no, invNoBase:r.inv_no_base, invDate:r.inv_date, orderId:r.order_id, amount:r.amount, notes:r.notes||"", items:getItems(type,r.inv_no), sellerSnapshot: r.seller_snapshot ? (()=>{try{return JSON.parse(r.seller_snapshot)}catch(e){return null}})() : null, charges: type==="tax_invoice" && r.charges ? (()=>{try{return JSON.parse(r.charges)}catch(e){return []}})() : [], orderSnapshot: r.order_snapshot ? (()=>{try{return JSON.parse(r.order_snapshot)}catch(e){return null}})() : null });
      const mapClient = (r) => ({ id:r.id, name:r.name, gstin:r.gstin||"", contact:r.contact||"", email:r.email||"", billingName:r.billing_name||"", billingAddress:r.billing_address||"", billingStateCode:r.billing_state_code||"", placeOfSupply:r.place_of_supply||"", shippingName:r.shipping_name||"", shippingContact:r.shipping_contact||"", shippingGstin:r.shipping_gstin||"", shippingAddress:r.shipping_address||"", shippingStateCode:r.shipping_state_code||"", isDeleted:r.is_deleted||false, clientType:r.client_type||"B2B" });
      const mapExpense = (r) => ({ id:r.id, date:r.date, paidBy:r.paid_by, amount:r.amount, category:r.category||"", comment:r.comment||"", isDeleted:r.is_deleted||false });
      const mapPayment = (r) => ({ id:r.id, orderId:r.order_id, date:r.date, amount:r.amount, mode:r.mode||"", receivedBy:r.received_by||"", txnRef:r.txn_ref||"", comments:r.comments||"" });
      const ordMapped = ord?.length ? ord.map(mapOrder) : [];
      const payMapped = pay?.length ? pay.map(mapPayment) : [];
      if (ordMapped.length) setOrders(ordMapped.map(o=>({...o, payments:payMapped.filter(p=>p.orderId===o.orderNo)})));
      if (qt?.length) setQuotations(qt.map(mapInv("quotation")));
      if (pf?.length) setProformas(pf.map(mapInv("proforma")));
      if (ti?.length) setTaxInvoices(ti.map(mapInv("tax_invoice")));
      if (cl?.length) setClients(cl.map(mapClient).filter(c=>!c.isDeleted));
      if (rc?.length) { const mapped=rc.map(r=>({id:r.id,name:r.name,isDeleted:r.is_deleted||false})); setRecipients(mapped.filter(r=>!r.isDeleted)); allRecipientsRef.current=mapped; }
      const mapAsset = (r) => ({ id:r.id, name:r.name||"", category:r.category||"", purchaseDate:r.purchase_date||"", amount:r.amount||0, paidBy:r.paid_by||"", vendor:r.vendor||"", description:r.description||"", invoiceUrl:r.invoice_url||"", invoicePublicId:r.invoice_public_id||"", linkedExpenseId:r.linked_expense_id||"", isDeleted:r.is_deleted||false });
      if (ass?.length) setAssets(ass.map(mapAsset).filter(a=>!a.isDeleted));
      if (ex?.length) setExpenses(ex.map(mapExpense).filter(e=>!e.isDeleted));
      if (sets?.length) {
        const s = {}; sets.forEach(r=>{ try{s[r.key]=JSON.parse(r.value)}catch(e){s[r.key]=r.value} });
        if (s.seller) setSeller(s.seller);
        if (s.series) setSeries(s.series);
      }
      if (stl?.length) setSettlements(stl.map(r=>({ id:r.id, date:r.date, amount:r.amount, ref:r.ref||"", fromId:r.from_id, via:r.via, direction:r.direction })));
      if (inv?.length) setInventory(inv.map(r=>({ id:r.id, brand:r.brand||"", material:r.material||"PLA", color:r.color||"", weightG:r.weight_g||1000, costTotal:r.cost_total||0, purchaseDate:r.purchase_date||"", notes:r.notes||"", linkedExpenseIds:r.linked_expense_ids||[] })).filter(r=>!r.isDeleted));
      if (prods?.length) setProducts(prods.map(r=>({ id:r.id, name:r.name||"", hsn:r.hsn||"", brand:r.brand||"", material:r.material||"", weightG:Number(r.weight_g)||0, unitPrice:Number(r.unit_price)||0, productType:r.product_type||"3d_printed", cgstRate:Number(r.cgst_rate)||9, sgstRate:Number(r.sgst_rate)||9, notes:r.notes||"" })));
      if (wlog?.length) setWastageLog(wlog.map(r=>({ id:r.id, date:r.date, brand:r.brand||"", material:r.material||"", color:r.color||"", weightG:r.weight_g||0, reason:r.reason||"", orderNo:r.order_no||"", notes:r.notes||"", groupKey:r.group_key||"" })));
    }).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  // ── Queue-based sync ────────────────────────────────────────────────────
  const flushQueue = useCallback(async ()=>{
    if (syncing.current || syncQueue.current.length===0 || !sb()) return;
    syncing.current = true;
    setSyncStatus("saving");
    const batch = [...syncQueue.current];
    syncQueue.current = [];
    try {
      for (const job of batch) {
        if (job.action==="upsert") await sb().from(job.table).upsert(job.row);  // row can be single obj or array
        else if (job.action==="delete") await sb().from(job.table).delete(job.col, job.val);
        else if (job.action==="deleteMany") await sb().from(job.table).deleteMany(job.col, [job.val]);
        else if (job.action==="saveSettings") {
          for (const [k,v] of Object.entries(job.data)) {
            await sb().from("settings").upsert({key:k, value: typeof v==="object"?JSON.stringify(v):String(v)});
          }
        }
      }
      setSyncStatus("saved");
    } catch(e) {
      setSyncStatus("error");
      toast("Failed to save changes — check your connection", "error");
    } finally {
      syncing.current = false;
      setTimeout(()=>setSyncStatus(""),3000);
      if (syncQueue.current.length>0) flushQueue();
    }
  },[sbUrl, sbKey]);

  const enqueue = useCallback((jobs)=>{
    syncQueue.current.push(...(Array.isArray(jobs)?jobs:[jobs]));
    setTimeout(flushQueue, 600);
  },[flushQueue]);

  // ── Items sync helper: delete old + insert new ──────────────────────────
  const syncItems = (docType, docId, items) => {
    const itemRows = (items||[]).map((it,i)=>({
      id: `${docType}_${docId}_${i+1}`,
      document_type: docType, document_id: docId,
      sl: it.sl||i+1, item: it.item||"", hsn: it.hsn||"", unit: it.unit||"Nos",
      unit_price: it.unitPrice||0, qty: it.qty||0, discount: it.discount||0,
      gross_amt: it.grossAmt||0, cgst_rate: it.cgstRate||0, cgst_amt: it.cgstAmt||0,
      sgst_rate: it.sgstRate||0, sgst_amt: it.sgstAmt||0, net_amt: it.netAmt||0,
      brand: it._brand||"", material: it._material||"", product_id: it._productId||""
    }));
    // upsert all item rows (merge-duplicates handles updates)
    if (itemRows.length) enqueue({action:"upsert",table:"items",row:itemRows});
    // delete removed items (items beyond current count)
    // we use a naming convention id = docType_docId_N so stale ones get overwritten on upsert
  };

  // ── Upsert helpers ───────────────────────────────────────────────────────
  const upsertOrder = (o) => {
    enqueue({action:"upsert",table:"orders",row:{
      order_no:o.orderNo, order_no_base:o.orderNoBase, type:o.type, customer_name:o.customerName,
      phone:o.phone||"", email:o.email||"", gstin:o.gstin||"", billing_name:o.billingName||"",
      billing_address:o.billingAddress||"", billing_state_code:o.billingStateCode||"",
      shipping_name:o.shippingName||"", shipping_address:o.shippingAddress||"",
      shipping_contact:o.shippingContact||"", shipping_gstin:o.shippingGstin||"",
      shipping_state_code:o.shippingStateCode||"", place_of_supply:o.placeOfSupply||"",
      order_date:o.orderDate, due_date:o.dueDate, payment_mode:o.paymentMode||"",
      advance:o.advance||0, advance_recipient:o.advanceRecipient||"", advance_txn_ref:o.advanceTxnRef||"",
      status:o.status||"Pending", comments:o.comments||"", needs_gst:o.needsGst!==false,
      quotation_no:o.quotationNo||"", proforma_ids:JSON.stringify(o.proformaIds||[]),
      tax_invoice_ids:JSON.stringify(o.taxInvoiceIds||[]),
      filament_usage:JSON.stringify(o.filamentUsage||[]),
      charges:JSON.stringify(o.charges||[])
    }});
    syncItems("order", o.orderNo, o.items);
  };
  const upsertQuotation = (q) => {
    enqueue({action:"upsert",table:"quotations",row:{
      inv_no:q.invNo, inv_no_base:q.invNoBase, inv_date:q.invDate,
      order_id:q.orderId, amount:q.amount||0, notes:q.notes||"",
      seller_snapshot: q.sellerSnapshot ? JSON.stringify(q.sellerSnapshot) : null,
      order_snapshot: q.orderSnapshot ? JSON.stringify(q.orderSnapshot) : null
    }});
    syncItems("quotation", q.invNo, q.items);
  };
  const upsertProforma = (p) => {
    enqueue({action:"upsert",table:"proformas",row:{
      inv_no:p.invNo, inv_no_base:p.invNoBase, inv_date:p.invDate,
      order_id:p.orderId, amount:p.amount||0, notes:p.notes||"",
      seller_snapshot: p.sellerSnapshot ? JSON.stringify(p.sellerSnapshot) : null,
      order_snapshot: p.orderSnapshot ? JSON.stringify(p.orderSnapshot) : null
    }});
    syncItems("proforma", p.invNo, p.items);
  };
  const upsertTaxInvoice = (t) => {
    enqueue({action:"upsert",table:"tax_invoices",row:{
      inv_no:t.invNo, inv_no_base:t.invNoBase, inv_date:t.invDate,
      order_id:t.orderId, amount:t.amount||0, notes:t.notes||"",
      seller_snapshot: t.sellerSnapshot ? JSON.stringify(t.sellerSnapshot) : null,
      order_snapshot: t.orderSnapshot ? JSON.stringify(t.orderSnapshot) : null,
      charges: t.charges?.length ? JSON.stringify(t.charges) : null
    }});
    syncItems("tax_invoice", t.invNo, t.items);
  };
  const upsertClient = (c) => enqueue({action:"upsert",table:"clients",row:{ is_deleted:c.isDeleted||false, client_type:c.clientType||"B2B",
    id:c.id, name:c.name, gstin:c.gstin||"", contact:c.contact||"", email:c.email||"",
    billing_name:c.billingName||"", billing_address:c.billingAddress||"",
    billing_state_code:c.billingStateCode||"", place_of_supply:c.placeOfSupply||"",
    shipping_name:c.shippingName||"", shipping_contact:c.shippingContact||"",
    shipping_gstin:c.shippingGstin||"", shipping_address:c.shippingAddress||"",
    shipping_state_code:c.shippingStateCode||""
  }});
  const upsertRecipient = (r) => enqueue({action:"upsert",table:"recipients",row:{id:r.id,name:r.name,is_deleted:r.isDeleted||false}});
  const upsertAsset = (a) => enqueue({action:"upsert",table:"assets",row:{
    id:a.id, name:a.name||"", category:a.category||"", purchase_date:a.purchaseDate||"",
    amount:a.amount||0, paid_by:a.paidBy||"", vendor:a.vendor||"", description:a.description||"",
    invoice_url:a.invoiceUrl||"", invoice_public_id:a.invoicePublicId||"",
    linked_expense_id:a.linkedExpenseId||"", is_deleted:a.isDeleted||false
  }});
  const deleteAsset = (a) => upsertAsset({...a, isDeleted:true});
  const syncSetAssets=(v)=>{ const n=typeof v==="function"?v(assets):v; setAssets(n); n.forEach(a=>{ const prev=assets.find(p=>p.id===a.id); if(!prev||JSON.stringify(prev)!==JSON.stringify(a)) upsertAsset(a); }); };

  const upsertExpense = (e) => enqueue({action:"upsert",table:"expenses",row:{ is_deleted:e.isDeleted||false,
    id:e.id, date:e.date, paid_by:e.paidBy, amount:e.amount||0,
    category:e.category||"", comment:e.comment||""
  }});
  const upsertPayment = (p) => enqueue({action:"upsert",table:"payments",row:{
    id:p.id, order_id:p.orderId, date:p.date, amount:p.amount||0,
    mode:p.mode||"", received_by:p.receivedBy||"", txn_ref:p.txnRef||"", comments:p.comments||""
  }});
  const deleteExpense = (e) => upsertExpense(e); // soft delete via is_deleted flag
  const deleteClient = (c) => upsertClient(c); // soft delete via is_deleted flag
  // deleteRecipient handled inline via upsertRecipient with isDeleted:true
  const saveSettings = (patch) => enqueue({action:"saveSettings",data:patch});

  // ── Sync-aware setters ──────────────────────────────────────────────────
  const syncSetOrders=(v)=>{ const n=typeof v==="function"?v(orders):v; setOrders(n); n.forEach(o=>{ const prev=orders.find(p=>p.orderNo===o.orderNo); if(!prev||JSON.stringify(prev)!==JSON.stringify(o)) upsertOrder(o); }); };
  const syncSetQuotations=(v)=>{ const n=typeof v==="function"?v(quotations):v; setQuotations(n); n.forEach(q=>{ const prev=quotations.find(p=>p.invNo===q.invNo); if(!prev||JSON.stringify(prev)!==JSON.stringify(q)) upsertQuotation(q); }); };
  const syncSetProformas=(v)=>{ const n=typeof v==="function"?v(proformas):v; setProformas(n); n.forEach(pf=>{ const prev=proformas.find(p=>p.invNo===pf.invNo); if(!prev||JSON.stringify(prev)!==JSON.stringify(pf)) upsertProforma(pf); }); };
  const syncSetTaxInvoices=(v)=>{ const n=typeof v==="function"?v(taxInvoices):v; setTaxInvoices(n); n.forEach(ti=>{ const prev=taxInvoices.find(p=>p.invNo===ti.invNo); if(!prev||JSON.stringify(prev)!==JSON.stringify(ti)) upsertTaxInvoice(ti); }); };
  const syncSetClients=(v)=>{ const n=typeof v==="function"?v(clients):v; setClients(n); n.forEach(c=>{ const prev=clients.find(p=>p.id===c.id); if(!prev||JSON.stringify(prev)!==JSON.stringify(c)) upsertClient(c); }); };
  const syncSetRecipients=(v)=>{ const n=typeof v==="function"?v(recipients):v; setRecipients(n); allRecipientsRef.current=[...allRecipientsRef.current.filter(r=>!n.find(x=>x.id===r.id)),...n]; n.forEach(r=>{ const prev=recipients.find(p=>p.id===r.id); if(!prev||JSON.stringify(prev)!==JSON.stringify(r)) upsertRecipient(r); }); };
  const syncSetExpenses=(v)=>{ const n=typeof v==="function"?v(expenses):v; setExpenses(n); n.forEach(ex=>{ const prev=expenses.find(p=>p.id===ex.id); if(!prev||JSON.stringify(prev)!==JSON.stringify(ex)) upsertExpense(ex); }); };
  const upsertInventoryItem=(i)=>enqueue({action:"upsert",table:"inventory",row:{id:i.id,brand:i.brand,material:i.material,color:i.color,weight_g:i.weightG,cost_total:i.costTotal||0,purchase_date:i.purchaseDate,notes:i.notes||"",linked_expense_ids:i.linkedExpenseIds||[]}});
  const upsertProduct=(p)=>enqueue({action:"upsert",table:"products",row:{id:p.id,name:p.name,hsn:p.hsn||"",brand:p.brand||"",material:p.material||"",weight_g:p.weightG||0,unit_price:p.unitPrice||0,product_type:p.productType||"3d_printed",cgst_rate:p.cgstRate||9,sgst_rate:p.sgstRate||9,notes:p.notes||""}});
  const deleteProduct=(id)=>enqueue({action:"delete",table:"products",col:"id",val:id});
  const syncSetProducts=(v)=>{ const n=typeof v==="function"?v(products):v; const removed=products.filter(x=>!n.find(y=>y.id===x.id)); removed.forEach(x=>deleteProduct(x.id)); n.forEach(p=>{ const prev=products.find(q=>q.id===p.id); if(!prev||JSON.stringify(prev)!==JSON.stringify(p)) upsertProduct(p); }); setProducts(n); };
  const upsertWastage=(w)=>enqueue({action:"upsert",table:"wastage_log",row:{id:w.id,date:w.date,brand:w.brand||"",material:w.material||"",color:w.color||"",weight_g:w.weightG,reason:w.reason,order_no:w.orderNo||"",notes:w.notes||"",group_key:w.groupKey||""}});
  const deleteWastage=(id)=>enqueue({action:"delete",table:"wastage_log",col:"id",val:id});
  const syncSetWastageLog=(v)=>{ const n=typeof v==="function"?v(wastageLog):v; const removed=wastageLog.filter(x=>!n.find(y=>y.id===x.id)); removed.forEach(x=>deleteWastage(x.id)); n.forEach(w=>{ const prev=wastageLog.find(p=>p.id===w.id); if(!prev||JSON.stringify(prev)!==JSON.stringify(w)) upsertWastage(w); }); setWastageLog(n); };
  const deleteInventoryItem=(i)=>enqueue({action:"delete",table:"inventory",col:"id",val:i.id});
  const syncSetInventory=(v)=>{ const n=typeof v==="function"?v(inventory):v; const removed=inventory.filter(x=>!n.find(y=>y.id===x.id)); removed.forEach(x=>deleteInventoryItem(x)); n.forEach(item=>{ const prev=inventory.find(p=>p.id===item.id); if(!prev||JSON.stringify(prev)!==JSON.stringify(item)) upsertInventoryItem(item); }); setInventory(n); };
  const upsertSettlement=(st)=>enqueue({action:"upsert",table:"settlements",row:{id:st.id,date:st.date,amount:st.amount,ref:st.ref||"",from_id:st.fromId,via:st.via,direction:st.direction}});
  const deleteSettlement=(id)=>enqueue({action:"delete",table:"settlements",col:"id",val:id});
  const syncSetSettlements=(v)=>{ const n=typeof v==="function"?v(settlements):v; const removed=settlements.filter(s=>!n.find(x=>x.id===s.id)); removed.forEach(s=>deleteSettlement(s.id)); n.forEach(st=>{ const prev=settlements.find(p=>p.id===st.id); if(!prev||JSON.stringify(prev)!==JSON.stringify(st)) upsertSettlement(st); }); setSettlements(n); };
  const syncSetSeller=(v)=>{ setSeller(v); saveSettings({seller:v}); };
  const syncSetSeries=(v)=>{ setSeries(v); saveSettings({series:v}); };

  // ── Auth handlers ────────────────────────────────────────────────────────
  const INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes
  const WARNING_MS = 3 * 60 * 1000;     // show countdown in last 3 minutes
  const inactivityTimer = useRef(null);
  const countdownInterval = useRef(null);
  const lastActivityTime = useRef(Date.now());
  const [countdown, setCountdown] = useState(null); // null = hidden, number = seconds left

  const handleLogout = useCallback(() => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    if (countdownInterval.current) clearInterval(countdownInterval.current);
    if (logoutTimer.current) clearTimeout(logoutTimer.current);
    setCountdown(null);
    if (sbRef.current && accessToken) sbRef.current.auth.signOut(accessToken).catch(()=>{});
    setAccessToken(""); setUser(null);
    sessionStorage.removeItem("sb_token");
    setOrders([]); setQuotations([]); setProformas([]); setTaxInvoices([]);
    setClients([]); setRecipients([]); setExpenses([]);
  }, [accessToken]);

  const logoutTimer = useRef(null); // separate ref so it can be cleared on activity

  const startCountdown = useCallback(() => {
    if (countdownInterval.current) clearInterval(countdownInterval.current);
    setCountdown(Math.floor(WARNING_MS / 1000));
    countdownInterval.current = setInterval(() => {
      const elapsed = Date.now() - lastActivityTime.current;
      const remaining = Math.max(0, Math.ceil((INACTIVITY_MS - elapsed) / 1000));
      setCountdown(remaining);
      if (remaining <= 0) clearInterval(countdownInterval.current);
    }, 1000);
    // Store the logout timer in a ref so it can be cancelled
    if (logoutTimer.current) clearTimeout(logoutTimer.current);
    logoutTimer.current = setTimeout(() => handleLogout(), WARNING_MS);
  }, [handleLogout]);

  const resetInactivityTimer = useCallback(() => {
    lastActivityTime.current = Date.now();
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    if (countdownInterval.current) clearInterval(countdownInterval.current);
    if (logoutTimer.current) clearTimeout(logoutTimer.current); // cancel pending logout
    setCountdown(null);
    // Set warning timer (fires at 7 mins to start 3 min countdown)
    inactivityTimer.current = setTimeout(() => {
      startCountdown();
    }, INACTIVITY_MS - WARNING_MS);
  }, [handleLogout, startCountdown]);

  // ── Start/reset inactivity timer on any user activity ──────────────────
  useEffect(() => {
    if (!accessToken) return;
    const events = ["mousedown","mousemove","keydown","scroll","touchstart","click"];
    events.forEach(e => window.addEventListener(e, resetInactivityTimer));
    resetInactivityTimer(); // start timer on login
    return () => {
      events.forEach(e => window.removeEventListener(e, resetInactivityTimer));
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      if (countdownInterval.current) clearInterval(countdownInterval.current);
    };
  }, [accessToken, resetInactivityTimer]);

  const handleLogin = (token, userData) => {
    setAccessToken(token);
    accessTokenRef.current = token;
    setUser(userData);
    sessionStorage.setItem("sb_token", token);
    window.location.reload();
  };

  // ── Supabase credentials handlers ───────────────────────────────────────
  const handleSetSbUrl=(v)=>{ setSbUrl(v); localStorage.setItem("sb_url",v); };
  const handleSetSbKey=(v)=>{ setSbKey(v); localStorage.setItem("sb_key",v); };

  const tabs=[{id:"new",label:"New Order"},{id:"orders",label:"Orders"},{id:"clients",label:"Clients"},{id:"expenses",label:"Expenses"},{id:"assets",label:"Assets"},{id:"inventory",label:"Inventory"},{id:"products",label:"Products"},{id:"income",label:"Income"},{id:"dashboard",label:"Splitwise"},{id:"download",label:"Download"},{id:"settings",label:"Settings"}];

  if (!accessToken) return <LoginScreen onLogin={handleLogin} sbUrl={sbUrl} sbKey={sbKey}/>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 font-sans">
      <style>{`input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield}`}</style>
      <Toast toasts={toasts}/>
      {loading&&<div className="fixed inset-0 z-50 bg-white/80 flex items-center justify-center"><div className="text-center"><div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-3"></div><p className="text-sm font-semibold text-indigo-600">Syncing your data…</p></div></div>}
      <div className="bg-white border-b border-gray-100 shadow-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {seller.logo
              ? <img src={seller.logo} alt="logo" className="h-9 max-w-[120px] object-contain"/>
              : <span className="text-base font-black text-slate-800 tracking-tight">{seller.name||"Elace"}</span>
            }
            {syncStatus==="error"&&<span className="text-xs text-red-400">Failed to save — check connection</span>}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
              {tabs.map(t=><button key={t.id} onClick={()=>setTab(t.id)} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all whitespace-nowrap ${tab===t.id?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700"}`}>{t.label}</button>)}
            </div>
            <button onClick={handleLogout} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold text-red-500 border border-red-200 hover:bg-red-50 transition-all">
              Sign Out{countdown!==null&&<span className="ml-1 text-xs font-black text-amber-600 tabular-nums bg-amber-100 px-1.5 py-0.5 rounded-md">{`${String(Math.floor(countdown/60)).padStart(2,"0")}:${String(countdown%60).padStart(2,"0")}`}</span>}
            </button>
          </div>
        </div>
      </div>
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 md:p-8">
          {tab==="new"&&<OrderForm orders={orders} setOrders={syncSetOrders} quotations={quotations} setQuotations={syncSetQuotations} proformas={proformas} setProformas={syncSetProformas} taxInvoices={taxInvoices} setTaxInvoices={syncSetTaxInvoices} seller={seller} series={series} clients={clients} recipients={recipients} onViewOrder={(o)=>{setViewOrder(o);setTab("orders");}} toast={toast} products={products}/>}
          {tab==="orders"&&<OrdersList orders={orders} setOrders={syncSetOrders} quotations={quotations} setQuotations={syncSetQuotations} proformas={proformas} setProformas={syncSetProformas} taxInvoices={taxInvoices} setTaxInvoices={syncSetTaxInvoices} seller={seller} series={series} recipients={recipients} allRecipients={allRecipientsRef.current} upsertPayment={upsertPayment} enqueue={enqueue} initialOrder={viewOrder} onClearInitialOrder={()=>setViewOrder(null)} toast={toast} inventory={inventory} wastageLog={wastageLog} setWastageLog={syncSetWastageLog} products={products}/>}
          {tab==="clients"&&<ClientMaster clients={clients} setClients={syncSetClients} deleteClient={deleteClient} toast={toast}/>}
          {tab==="expenses"&&<ExpenseTracker expenses={expenses} setExpenses={syncSetExpenses} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller} deleteExpense={deleteExpense} toast={toast}/>}
          {tab==="assets"&&<AssetManager assets={assets} setAssets={syncSetAssets} deleteAsset={deleteAsset} expenses={expenses} setExpenses={syncSetExpenses} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller} cdnCloud={cdnCloud} cdnPreset={cdnPreset} toast={toast}/>}
          {tab==="products"&&<ProductManager products={products} setProducts={syncSetProducts} seller={seller} toast={toast} inventory={inventory}/>}
          {tab==="inventory"&&<InventoryManager inventory={inventory} setInventory={syncSetInventory} expenses={expenses} setExpenses={syncSetExpenses} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller} setSeller={syncSetSeller} deleteInventoryItem={deleteInventoryItem} toast={toast} orders={orders} wastageLog={wastageLog} setWastageLog={syncSetWastageLog}/>}
          {tab==="income"&&<IncomeView orders={orders} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller}/>}
          {tab==="download"&&<BulkDownload orders={orders} quotations={quotations} proformas={proformas} taxInvoices={taxInvoices} seller={seller}/>}
          {tab==="dashboard"&&<Dashboard orders={orders} expenses={expenses} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller} settlements={settlements} setSettlements={syncSetSettlements}/>}
          {tab==="settings"&&<Settings sbUrl={sbUrl} setSbUrl={handleSetSbUrl} sbKey={sbKey} setSbKey={handleSetSbKey} seller={seller} setSeller={syncSetSeller} series={series} setSeries={syncSetSeries} recipients={recipients} setRecipients={syncSetRecipients} upsertRecipient={upsertRecipient} allRecipients={allRecipientsRef.current} toast={toast} syncStatus={syncStatus}/>}
        </div>
      </div>
    </div>
  );
}

export default App;
