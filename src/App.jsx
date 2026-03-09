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
create table if not exists orders (
  order_no text primary key, order_no_base text, type text, customer_name text,
  phone text, email text, gstin text, billing_name text, billing_address text,
  billing_state_code text, shipping_name text, shipping_address text,
  shipping_contact text, shipping_gstin text, shipping_state_code text,
  place_of_supply text, order_date text, due_date text, payment_mode text,
  advance numeric default 0, advance_recipient text, advance_txn_ref text,
  status text, comments text, needs_gst boolean default true,
  quotation_no text, proforma_ids text, tax_invoice_ids text,
  created_at timestamptz default now()
);
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
  order_id text, amount numeric default 0, notes text,
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
  created_at timestamptz default now()
);
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
-- Settings
create table if not exists settings (
  key text primary key, value text,
  created_at timestamptz default now()
);`;

// ─── Quotation HTML Builder ──────────────────────────────────────────────────
function buildQuotationHtml(order, inv, seller) {
  seller = inv.sellerSnapshot || seller;
  const items = inv.items || [];
  const tG = items.reduce((s,i)=>s+num(i.grossAmt),0);
  const tC = items.reduce((s,i)=>s+num(i.cgstAmt),0);
  const tS = items.reduce((s,i)=>s+num(i.sgstAmt),0);
  const tN = items.reduce((s,i)=>s+num(i.netAmt),0);
  const ng = order.needsGst;
  const cols = ng ? 13 : 9;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${inv.invNo}</title>
<style>
  *{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#1a1a1a;margin:0;padding:24px;background:#fff}
  .page{max-width:900px;margin:0 auto}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1a1a2e;padding-bottom:14px;margin-bottom:14px}
  .co-name{font-size:19px;font-weight:800;color:#1a1a2e;margin:4px 0 2px}.sd{font-size:11px;color:#444;line-height:1.6}
  .inv-title{font-size:17px;font-weight:800;color:#0369a1;letter-spacing:1px;text-align:right}
  .inv-meta{font-size:11px;margin-top:6px;line-height:1.9;text-align:right}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}
  .box{border:1px solid #ddd;border-radius:5px;padding:9px 11px;font-size:11px;line-height:1.7}
  .bt{font-size:10px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:4px}
  table{width:100%;border-collapse:collapse;margin:10px 0;font-size:11px}
  th{background:#1a1a2e;color:#fff;padding:7px 8px;text-align:center;font-weight:600;white-space:nowrap}
  td{padding:5px 8px;border-bottom:1px solid #eee;text-align:center}
  .sr td{background:#f7f7f7;font-weight:600}.gr td{background:#1a1a2e;color:#fff;font-weight:700;font-size:13px}
  .foot{margin-top:16px;text-align:right;font-size:10px;color:#999;border-top:1px solid #eee;padding-top:8px}
  .validity{margin-top:12px;padding:10px 12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:5px;font-size:11px;color:#1e40af}
  @media print{body{padding:8px}}
</style></head><body><div class="page">
<div class="hdr">
  <div>${seller.logo?`<img src="${seller.logo}" style="max-height:60px;max-width:160px;object-fit:contain;margin-bottom:4px;display:block"/>`:""}
    <div class="co-name">${seller.name}</div>
    <div class="sd">${seller.address}<br>GSTIN: <b>${seller.gstin}</b> | State: ${seller.state} (${seller.stateCode})<br>${seller.phone} | ${seller.email}</div>
  </div>
  <div><div class="inv-title">QUOTATION</div>
    <div class="inv-meta"><b>Quotation #:</b> ${inv.invNo}<br><b>Date:</b> ${inv.invDate}<br><b>Order #:</b> ${order.orderNo}<br>${order.placeOfSupply?`<b>Place of Supply:</b> ${order.placeOfSupply}<br>`:""}</div>
  </div>
</div>
<div class="two-col">
  <div class="box"><div class="bt">Bill To</div><b>${order.billingName||order.customerName}</b><br>${order.billingAddress||""}<br>${order.type==="B2B"?`GSTIN: ${order.gstin||"-"}<br>State Code: ${order.billingStateCode||"-"}<br>`:""}${order.phone||order.contact||""}${order.email?`<br>${order.email}`:""}</div>
  <div class="box"><div class="bt">Ship To</div><b>${order.shippingName||order.billingName||order.customerName}</b><br>${order.shippingAddress||order.billingAddress||""}<br>${order.type==="B2B"?`GSTIN: ${order.shippingGstin||order.gstin||"-"}<br>State Code: ${order.shippingStateCode||order.billingStateCode||"-"}<br>`:""} ${order.shippingContact?`${order.shippingContact}<br>`:""}</div>
</div>
<table><thead><tr>
  <th>#</th><th>Item / Description</th><th>HSN</th><th>Unit</th>
  <th>Qty</th><th>Unit Price</th><th>Disc%</th><th>Gross</th>
  ${ng?`<th>CGST%</th><th>CGST</th><th>SGST%</th><th>SGST</th>`:""}
  <th>Net Amount</th>
</tr></thead><tbody>
${items.map((it,i)=>`<tr><td>${i+1}</td><td>${it.item}</td><td>${it.hsn||"-"}</td><td>${it.unit}</td>
  <td>${it.qty}</td><td>₹${fmt(it.unitPrice)}</td><td>${it.discount||0}%</td><td>₹${fmt(it.grossAmt)}</td>
  ${ng?`<td>${it.cgstRate}%</td><td>₹${fmt(it.cgstAmt)}</td><td>${it.sgstRate}%</td><td>₹${fmt(it.sgstAmt)}</td>`:""}
  <td><b>₹${fmt(it.netAmt)}</b></td></tr>`).join("")}
</tbody><tfoot>
  <tr class="sr"><td colspan="${ng?7:7}" style="text-align:right">Subtotals</td><td>₹${fmt(tG)}</td>${ng?`<td></td><td>₹${fmt(tC)}</td><td></td><td>₹${fmt(tS)}</td>`:""}<td>₹${fmt(tN)}</td></tr>
  <tr class="gr"><td colspan="${cols-1}" style="text-align:right">GRAND TOTAL</td><td>₹${fmt(tN)}</td></tr>
</tfoot></table>
${inv.notes?`<div style="font-size:11px;color:#555;margin:8px 0"><b>Notes:</b> ${inv.notes}</div>`:""}
<div class="validity">This is a quotation only and not a tax invoice. Prices are valid for 15 days from the date of issue.</div>
<div class="foot">Computer-generated — no signature required.</div>
</div></body></html>`;
}

// ─── Invoice HTML Builder ─────────────────────────────────────────────────────
function buildInvoiceHtml(order, inv, type, seller) {
  seller = inv.sellerSnapshot || seller;
  const isProforma = type === "proforma";
  const title = isProforma ? "PROFORMA INVOICE" : "TAX INVOICE";
  const items = inv.items || [];
  const tG = items.reduce((s,i)=>s+num(i.grossAmt),0);
  const tC = items.reduce((s,i)=>s+num(i.cgstAmt),0);
  const tS = items.reduce((s,i)=>s+num(i.sgstAmt),0);
  const tN = items.reduce((s,i)=>s+num(i.netAmt),0);
  const ng = order.needsGst;
  const cols = ng ? 13 : 9;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${inv.invNo}</title>
<style>
  *{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#1a1a1a;margin:0;padding:24px;background:#fff}
  .page{max-width:900px;margin:0 auto}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1a1a2e;padding-bottom:14px;margin-bottom:14px}
  .co-name{font-size:19px;font-weight:800;color:#1a1a2e;margin:4px 0 2px}.sd{font-size:11px;color:#444;line-height:1.6}
  .inv-title{font-size:17px;font-weight:800;color:#c0392b;letter-spacing:1px;text-align:right}
  .inv-meta{font-size:11px;margin-top:6px;line-height:1.9;text-align:right}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}
  .box{border:1px solid #ddd;border-radius:5px;padding:9px 11px;font-size:11px;line-height:1.7}
  .bt{font-size:10px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:4px}
  table{width:100%;border-collapse:collapse;margin:10px 0;font-size:11px}
  th{background:#1a1a2e;color:#fff;padding:7px 8px;text-align:center;font-weight:600;white-space:nowrap}
  td{padding:5px 8px;border-bottom:1px solid #eee;text-align:center}
  .sr td{background:#f7f7f7;font-weight:600}.gr td{background:#1a1a2e;color:#fff;font-weight:700;font-size:13px}
  .bank{margin-top:14px;padding:10px 12px;background:#f4f4f4;border-radius:5px;font-size:11px;line-height:1.8}
  .foot{margin-top:16px;text-align:right;font-size:10px;color:#999;border-top:1px solid #eee;padding-top:8px}
  @media print{body{padding:8px}}
</style></head><body><div class="page">
<div class="hdr">
  <div>${seller.logo?`<img src="${seller.logo}" style="max-height:60px;max-width:160px;object-fit:contain;margin-bottom:4px;display:block"/>`:""}
    <div class="co-name">${seller.name}</div>
    <div class="sd">${seller.address}<br>GSTIN: <b>${seller.gstin}</b> | State: ${seller.state} (${seller.stateCode})<br>${seller.phone} | ${seller.email}</div>
  </div>
  <div><div class="inv-title">${title}</div>
    <div class="inv-meta"><b>Invoice #:</b> ${inv.invNo}<br><b>Date:</b> ${inv.invDate}<br><b>Order #:</b> ${order.orderNo}<br>${order.placeOfSupply?`<b>Place of Supply:</b> ${order.placeOfSupply}<br>`:""}</div>
  </div>
</div>
<div class="two-col">
  <div class="box"><div class="bt">Bill To</div><b>${order.billingName||order.customerName}</b><br>${order.billingAddress||""}<br>${order.type==="B2B"?`GSTIN: ${order.gstin||"-"}<br>State Code: ${order.billingStateCode||"-"}<br>`:""}${order.phone||order.contact||""}${order.email?`<br>${order.email}`:""}</div>
  <div class="box"><div class="bt">Ship To</div><b>${order.shippingName||order.billingName||order.customerName}</b><br>${order.shippingAddress||order.billingAddress||""}<br>${order.type==="B2B"?`GSTIN: ${order.shippingGstin||order.gstin||"-"}<br>State Code: ${order.shippingStateCode||order.billingStateCode||"-"}<br>`:""} ${order.shippingContact?`${order.shippingContact}<br>`:""}</div>
</div>
<table><thead><tr>
  <th>#</th><th>Item / Description</th><th>HSN</th><th>Unit</th>
  <th>Qty</th><th>Unit Price</th><th>Disc%</th><th>Gross</th>
  ${ng?`<th>CGST%</th><th>CGST</th><th>SGST%</th><th>SGST</th>`:""}
  <th>Net Amount</th>
</tr></thead><tbody>
${items.map((it,i)=>`<tr><td>${i+1}</td><td>${it.item}</td><td>${it.hsn||"-"}</td><td>${it.unit}</td>
  <td>${it.qty}</td><td>₹${fmt(it.unitPrice)}</td><td>${it.discount||0}%</td><td>₹${fmt(it.grossAmt)}</td>
  ${ng?`<td>${it.cgstRate}%</td><td>₹${fmt(it.cgstAmt)}</td><td>${it.sgstRate}%</td><td>₹${fmt(it.sgstAmt)}</td>`:""}
  <td><b>₹${fmt(it.netAmt)}</b></td></tr>`).join("")}
</tbody><tfoot>
  <tr class="sr"><td colspan="${ng?7:7}" style="text-align:right">Subtotals</td><td>₹${fmt(tG)}</td>${ng?`<td></td><td>₹${fmt(tC)}</td><td></td><td>₹${fmt(tS)}</td>`:""}<td>₹${fmt(tN)}</td></tr>
  <tr class="gr"><td colspan="${cols-1}" style="text-align:right">GRAND TOTAL</td><td>₹${fmt(tN)}</td></tr>
</tfoot></table>

${inv.notes?`<div style="font-size:11px;color:#555;margin:8px 0"><b>Notes:</b> ${inv.notes}</div>`:""}
${!isProforma?`<div class="bank"><b>Bank Details:</b> ${seller.bank} | A/C No: ${seller.accountNo} | IFSC: ${seller.ifsc}</div>`:""}
${(isProforma&&seller.pfTerms)||(!isProforma&&seller.tiTerms)?`<div style="margin-top:12px;padding:10px 12px;background:#f9f9f9;border:1px solid #eee;border-radius:5px;font-size:10px;color:#444;line-height:1.8"><b style="font-size:11px">Terms & Conditions</b><br>${isProforma?(seller.pfTerms||"").replace(/\n/g,"<br>"):(seller.tiTerms||"").replace(/\n/g,"<br>")}</div>`:""}
<div class="foot">Computer-generated — no signature required.${isProforma?" This is a Proforma Invoice and not a Tax Invoice.":""}</div>
</div></body></html>`;
}

function printOrOpen(html) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function downloadHtml(html, filename) {
  // Inject auto-print script so browser PDF dialog opens immediately
  const printHtml = html.replace("</body>", `<script>window.onload=function(){window.print();}<\/script></body>`);
  const blob = new Blob([printHtml], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 30000);
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
          : <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} disabled={disabled} className={b} {...(type==="number"?{onWheel:e=>e.target.blur(),inputMode:"decimal"}:{})}/>
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
function ItemTable({ items, setItems, needsGst }) {
  const upd = (i,f,v) => setItems(items.map((it,idx)=>idx===i?calcItem({...it,[f]:v},needsGst):it));
  const add = () => setItems([...items, {...EMPTY_ITEM, sl:items.length+1}]);
  const del = (i) => setItems(items.filter((_,idx)=>idx!==i).map((it,idx)=>({...it,sl:idx+1})));
  const tG=items.reduce((s,i)=>s+num(i.grossAmt),0), tC=items.reduce((s,i)=>s+num(i.cgstAmt),0), tS=items.reduce((s,i)=>s+num(i.sgstAmt),0), tN=items.reduce((s,i)=>s+num(i.netAmt),0);
  const inp = "border-0 bg-transparent focus:outline-none focus:bg-indigo-50 rounded px-1 w-full";
  const hdrs = ["#","Item / Description","HSN","Unit","Unit Price","Qty","Disc%",...(needsGst?["CGST%","SGST%"]:[]),"Gross",...(needsGst?["CGST","SGST"]:[]),"Net Amt",""];
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100">
      <table className="w-full text-xs border-collapse" style={{minWidth:needsGst?"1020px":"680px"}}>
        <thead><tr className="bg-slate-800 text-white">{hdrs.map((h,i)=><th key={i} className="px-2 py-2.5 text-left font-semibold whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>
          {items.map((it,i)=>(
            <tr key={i} className="border-b border-gray-100 hover:bg-slate-50">
              <td className="px-2 py-1.5 text-gray-400 w-6">{it.sl}</td>
              <td className="px-2 py-1.5"><input value={it.item} onChange={e=>upd(i,"item",e.target.value)} placeholder="Item name" className={inp+" min-w-[140px]"}/></td>
              <td className="px-2 py-1.5"><input value={it.hsn} onChange={e=>upd(i,"hsn",e.target.value)} placeholder="HSN" className={inp+" w-16"}/></td>
              <td className="px-2 py-1.5"><select value={it.unit} onChange={e=>upd(i,"unit",e.target.value)} className="border-0 bg-transparent text-xs focus:outline-none">{["Nos","Kg","Ltr","Mtr","Sqft","Box","Set","Pair"].map(u=><option key={u}>{u}</option>)}</select></td>
              <td className="px-2 py-1.5"><input type="number" value={it.unitPrice} onChange={e=>upd(i,"unitPrice",e.target.value)} onWheel={e=>e.target.blur()} inputMode="decimal" className={inp+" w-20 text-right"}/></td>
              <td className="px-2 py-1.5"><input type="number" value={it.qty} onChange={e=>upd(i,"qty",e.target.value)} onWheel={e=>e.target.blur()} inputMode="decimal" className={inp+" w-14 text-right"}/></td>
              <td className="px-2 py-1.5"><input type="number" value={it.discount} onChange={e=>upd(i,"discount",e.target.value)} onWheel={e=>e.target.blur()} inputMode="decimal" className={inp+" w-12 text-right"}/></td>
              {needsGst&&<>
                <td className="px-2 py-1.5"><select value={it.cgstRate} onChange={e=>upd(i,"cgstRate",e.target.value)} className="border-0 bg-transparent text-xs focus:outline-none w-14">{GST_RATES.map(r=><option key={r} value={r}>{r}%</option>)}</select></td>
                <td className="px-2 py-1.5"><select value={it.sgstRate} onChange={e=>upd(i,"sgstRate",e.target.value)} className="border-0 bg-transparent text-xs focus:outline-none w-14">{GST_RATES.map(r=><option key={r} value={r}>{r}%</option>)}</select></td>
              </>}
              <td className="px-2 py-1.5 text-right text-gray-600">₹{fmt(it.grossAmt)}</td>
              {needsGst&&<><td className="px-2 py-1.5 text-right text-gray-500">₹{fmt(it.cgstAmt)}</td><td className="px-2 py-1.5 text-right text-gray-500">₹{fmt(it.sgstAmt)}</td></>}
              <td className="px-2 py-1.5 text-right font-bold text-slate-800">₹{fmt(it.netAmt)}</td>
              <td className="px-2 py-1.5"><button onClick={()=>del(i)} className="text-red-400 hover:text-red-600 font-bold px-1 text-base leading-none">×</button></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-slate-50 font-semibold">
            <td colSpan={needsGst?9:7} className="px-2 py-2 text-right text-gray-400 text-xs">Totals →</td>
            <td className="px-2 py-2 text-right text-xs">₹{fmt(tG)}</td>
            {needsGst&&<><td className="px-2 py-2 text-right text-xs">₹{fmt(tC)}</td><td className="px-2 py-2 text-right text-xs">₹{fmt(tS)}</td></>}
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
function OrderForm({ orders, setOrders, quotations, setQuotations, proformas, setProformas, taxInvoices, setTaxInvoices, seller, series, clients, recipients=[], onViewOrder=()=>{}, toast=()=>{} }) {
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
    if (!customerName) { notify("Customer name is required",true); return; }
    if (num(advance)>0 && !advanceRecipient) { notify("Please select who received the advance",true); return; }
    setSaving(true);
    const orderNoBase = [series.prefix, series.format==="YYYYMM"?yyyymm():series.format==="YYYY"?yyyy():series.format==="YYYYMMDD"?yyyymmdd():""].filter(Boolean).join("/");
    const orderNo = buildOrderNo(series, type, orders);
    // Generate quotation number
    const qtPeriod = series.qtFormat==="YYYYMM"?yyyymm():series.qtFormat==="YYYY"?yyyy():series.qtFormat==="YYYYMMDD"?yyyymmdd():"";
    const {invNo:qtNo, invNoBase:qtBase} = genInvNo(series.qtPrefix||"QT", qtPeriod, quotations, Number(series.qtDigits)||6);
    const order = { orderNo, orderNoBase, type, customerName, phone, email, contact: phone, gstin, billingName, billingAddress, billingStateCode, shippingName, shippingAddress, shippingContact, shippingGstin, shippingStateCode, placeOfSupply, orderDate, dueDate: dueDate||addDays(orderDate,30), paymentMode, advance, advanceRecipient, advanceTxnRef, status, comments, needsGst, items, quotationNo: qtNo, proformaIds:[], taxInvoiceIds:[] };
    const qt = { invNo:qtNo, invNoBase:qtBase, invDate:orderDate, items:[...items.map(i=>({...i}))], notes:comments, orderId:orderNo, amount:items.reduce((s,i)=>s+num(i.netAmt),0), sellerSnapshot:{...seller} };
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
            <ItemTable items={items} setItems={setItems} needsGst={needsGst}/>
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
function OrderEditDrawer({ order, quotations, proformas, taxInvoices, seller, series, onClose, onSaveOrder, onSaveInvoice, onCreateInvoice, onDeleteOrder=()=>{}, recipients=[], toast=()=>{} }) {
  const [tab, setTab] = useState("details");
  const [o, setO] = useState({...order});
  const [editInv, setEditInv] = useState(null);
  const [creating, setCreating] = useState(null); // "proforma" | "tax"
  const [payments, setPayments] = useState(order.payments||[]);
  const [newPay, setNewPay] = useState({date:today(), amount:"", mode:"UPI", receivedBy:"", txnRef:"", comments:""});

  // Keep payments in sync with parent order prop (so reopening shows saved payments)
  useEffect(() => { setPayments(order.payments||[]); }, [order.payments]);
  // Keep order fields in sync when parent updates (e.g. after save)
  useEffect(() => { setO(prev=>({...order, ...prev, payments: order.payments||[] })); }, [order.orderNo]);

  const upd = (k,v) => setO(p=>({...p,[k]:v}));
  const qt = quotations.find(q=>q.orderId===order.orderNo);
  // Local editable items
  const [orderItems, setOrderItems] = useState((order.items||[]).map(i=>({...i})));
  // Sync orderItems when order.items prop changes (e.g. after initial load from Supabase)
  const prevOrderNo = useRef(order.orderNo);
  useEffect(() => {
    if (prevOrderNo.current !== order.orderNo) {
      // Only reinit if a different order opened
      setOrderItems((order.items||[]).map(i=>({...i})));
      prevOrderNo.current = order.orderNo;
    }
  }, [order.orderNo, order.items]);
  const pfs = proformas.filter(p=>p.orderId===order.orderNo);
  const tis = taxInvoices.filter(t=>t.orderId===order.orderNo);

  const handleSaveOrder = () => {
    const updated = {...o, items: orderItems};
    onSaveOrder(updated);
    toast("Order changes saved");
  };
  const handleSaveInv = (updatedInv, type) => {
    const saved = {...updatedInv, amount:updatedInv.items.reduce((s,i)=>s+num(i.netAmt),0)};
    onSaveInvoice(saved, type);
    setEditInv(null);
  };
  const handleCreate = (type) => setCreating(type);

  const totalPaid = payments.reduce((s,p)=>s+num(p.amount),0) + num(o.advance);
  const handleAddPayment = () => {
    if (!newPay.amount || isNaN(num(newPay.amount))) return;
    if (!newPay.receivedBy) { alert("Please select who received this payment."); return; }
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
    const newInv = {...inv, orderId:order.orderNo, amount:inv.items.reduce((s,i)=>s+num(i.netAmt),0), sellerSnapshot:{...seller}};
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

        {/* Tabs */}
        <div className="flex border-b shrink-0 bg-gray-50">
          {[["details","Order"],["quotation","Quotation"],["invoices","Invoices"],["payments","Payments"]].map(([id,label])=>(
            <button key={id} onClick={()=>{setTab(id);setEditInv(null);setCreating(null);}}
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
              <div className="border-t pt-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-gray-700">Order Items</p>
                  <span className="text-xs text-gray-400">Edit items here to update quotation</span>
                </div>
                <ItemTable items={orderItems} setItems={setOrderItems} needsGst={o.needsGst}/>
              </div>
              <div className="pt-3 border-t space-y-3">
                <button
                  onClick={handleSaveOrder}
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
                      <div className="opacity-70 select-none" onMouseDown={e=>e.preventDefault()}><ItemTable items={qt.items.map(i=>({...i}))} setItems={()=>{}} needsGst={order.needsGst}/></div>
                    </div>
                  </>
                : <p className="text-gray-400 text-sm text-center py-8">No quotation found for this order.</p>
              }
            </div>
          )}

          {tab==="invoices" && !editInv && !creating && (
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
                            <button onClick={()=>setEditInv({inv:{...p,items:p.items.map(i=>({...i}))},type:"proforma"})} className="text-xs border border-blue-300 text-blue-700 hover:bg-blue-100 px-3 py-1.5 rounded-lg font-medium">✏️ Edit</button>
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
                            <button onClick={()=>setEditInv({inv:{...t,items:t.items.map(i=>({...i}))},type:"tax"})} className="text-xs border border-slate-300 text-slate-700 hover:bg-slate-200 px-3 py-1.5 rounded-lg font-medium">✏️ Edit</button>
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
            <InvoiceEditor
              inv={{ invNo:"(auto)", invDate:today(), items: orderItems && orderItems.length > 0 ? orderItems.map(i=>({...i})) : [{...EMPTY_ITEM}], notes:"" }}
              type={creating}
              needsGst={creating==="tax" ? true : order.needsGst}
              isNew={true}
              series={series}
              existingList={creating==="proforma" ? proformas : taxInvoices}
              onSave={(inv)=>handleSaveNew(inv, creating)}
              onCancel={()=>setCreating(null)}
            />
          )}

          {tab==="invoices" && editInv && !creating && (
            <InvoiceEditor
              inv={editInv.inv}
              type={editInv.type}
              needsGst={order.needsGst}
              onSave={(updated)=>handleSaveInv(updated, editInv.type)}
              onCancel={()=>setEditInv(null)}
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
function InvoiceEditor({ inv, type, needsGst, onSave, onCancel, isNew, series, existingList }) {
  const prefix = isNew ? (type==="proforma"?(series?.pfPrefix||"PF"):(series?.tiPrefix||"TAX")) : null;
  const period = isNew ? (type==="proforma"?(series?.pfFormat==="YYYYMM"?yyyymm():series?.pfFormat==="YYYY"?yyyy():series?.pfFormat==="YYYYMMDD"?yyyymmdd():""):(series?.tiFormat==="YYYYMM"?yyyymm():series?.tiFormat==="YYYY"?yyyy():series?.tiFormat==="YYYYMMDD"?yyyymmdd():"")) : null;
  const { invNo:autoNo, invNoBase:autoBase } = isNew ? genInvNo(prefix, period, existingList||[], Number(series?.invDigits)||6) : { invNo: inv.invNo, invNoBase: inv.invNoBase };
  const [d, setD] = useState({...inv, items: inv.items.map(i=>({...i})), invNo: isNew ? autoNo : inv.invNo, invNoBase: isNew ? autoBase : inv.invNoBase });
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
      <ItemTable items={d.items} setItems={items=>setD(p=>({...p,items}))} needsGst={needsGst}/>
      <F label="Notes" value={d.notes||""} onChange={v=>upd("notes",v)} rows={2}/>
      <div className="flex gap-3 pt-2 border-t">
        <button onClick={()=>{ onSave(d); }} className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-lg font-semibold text-sm">✓ Save Invoice</button>
        <button onClick={onCancel} className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-4 py-2.5 rounded-lg text-sm">Cancel</button>
      </div>
    </div>
  );
}

// ─── Orders List ──────────────────────────────────────────────────────────────
function OrdersList({ orders, setOrders, quotations, setQuotations, proformas, setProformas, taxInvoices, setTaxInvoices, seller, series, recipients=[], allRecipients=[], upsertPayment=()=>{}, enqueue=()=>{}, initialOrder=null, onClearInitialOrder=()=>{}, toast=()=>{} }) {
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
      // Also sync to tax invoices — merge new items in, keep existing ones
      setTaxInvoices(prev => prev.map(t => {
        if (t.orderId !== orderNo) return t;
        const existingNames = new Set((t.items||[]).map(i=>(i.item||"").toLowerCase().trim()));
        const toAdd = newItems.filter(i => i.item && !existingNames.has((i.item||"").toLowerCase().trim()));
        const merged = [...(t.items||[]), ...toAdd].map((i,idx)=>({...i,sl:idx+1}));
        return {...t, items:merged, amount:merged.reduce((s,i)=>s+num(i.netAmt),0)};
      }));
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

  const handleSaveInvoice = (updatedInv, type, mergedItems) => {
    toast(type==="proforma"?"Proforma saved":"Tax invoice saved");
    const orderNo = openOrder?.orderNo;
    if(type==="proforma"){
      setProformas(proformas.map(p=>p.invNo===updatedInv.invNo?updatedInv:p));
      // Do NOT push proforma items back to order/quotation/tax invoice
    } else {
      setTaxInvoices(taxInvoices.map(t=>t.invNo===updatedInv.invNo?updatedInv:t));
      // Do NOT push tax invoice items back to order/quotation
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
        <div className="flex gap-4 mt-2 flex-wrap">
          <div>
            <p className="text-xs text-gray-400 leading-none mb-0.5">Order Date</p>
            <p className="text-xs font-semibold text-gray-600">{o.orderDate||"—"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 leading-none mb-0.5">Due Date</p>
            <p className={`text-xs font-semibold ${isOverdue?"text-red-600":isDueSoon?"text-amber-600":"text-gray-600"}`}>{due||"—"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 leading-none mb-0.5">Total</p>
            <p className="text-xs font-semibold text-gray-800">{tN>0?`₹${fmt(tN)}`:"—"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 leading-none mb-0.5">Advance</p>
            <p className="text-xs font-semibold text-emerald-600">{num(o.advance)>0?`₹${fmt(o.advance)}`:"—"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 leading-none mb-0.5">Balance Due</p>
            <p className={`text-xs font-semibold ${bal>0?"text-orange-500":"text-gray-400"}`}>{tN>0?(bal>0?`₹${fmt(bal)}`:"Nil"):"—"}</p>
          </div>
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
          toast={toast}
          recipients={recipients}
        />
      )}
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function Settings({ sbUrl="", setSbUrl=()=>{}, sbKey="", setSbKey=()=>{}, seller, setSeller, series, setSeries, recipients=[], setRecipients, upsertRecipient=()=>{}, allRecipients=[], toast=()=>{} }) {
  const [s,setS]=useState({...seller}); const [sr,setSr]=useState({...series});
  const [showSetup,setShowSetup]=useState(false);
  const logoRef=useRef();

  const handleLogo = e => { const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>setS(p=>({...p,logo:ev.target.result})); r.readAsDataURL(f); };
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
        <h3 className="font-bold text-gray-800 mb-4">🏢 Business Details</h3>
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
        <h3 className="font-bold text-gray-800 mb-2">🖼 Company Logo</h3>
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

      {/* Number Series */}
      <section className="border-t pt-6">
        <h3 className="font-bold text-gray-800 mb-1">🔢 Number Series</h3>
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
        <h3 className="font-bold text-gray-800 mb-1">📋 Terms &amp; Conditions</h3>
        <p className="text-xs text-gray-400 mb-4">Printed at the bottom of each invoice. Leave blank to omit.</p>
        <div className="space-y-4">
          <F label="Proforma Invoice — Terms & Conditions" value={s.pfTerms} onChange={v=>setS({...s,pfTerms:v})} rows={4} placeholder="Enter terms for proforma invoices…"/>
          <F label="Tax Invoice — Terms & Conditions" value={s.tiTerms} onChange={v=>setS({...s,tiTerms:v})} rows={4} placeholder="Enter terms for tax invoices…"/>
        </div>
      </section>

      {/* Supabase status indicator only */}
      <section className="border-t pt-6">
        <h3 className="font-bold text-gray-800 mb-1">🗄️ Supabase Database</h3>
        {(sbUrl&&sbKey)
          ? <p className="text-xs text-emerald-600 font-medium">✓ Connected to Supabase</p>
          : <p className="text-xs text-red-400 font-medium">⚠ Not connected — set VITE_SUPABASE_URL and VITE_SUPABASE_KEY in your environment</p>
        }
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-bold text-gray-800 border-b pb-2">👤 Recipients</h2>
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
        <h3 className="font-bold text-gray-800 mb-1">{editId?"✏️ Edit Recipient":"➕ Add Recipient"}</h3>
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
    if (!form.name) return;
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
const EXPENSE_CATEGORIES = ["Electricity","Groceries","Entertainment","Filament","Resin","Rent","Debt","Travel","Miscellaneous"];
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

  const notify = (m, err=false) => { if(err){setMsg(m);setTimeout(()=>setMsg(""),2500);}else{toast(m);} };

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
        <h3 className="font-bold text-gray-800 text-sm">{editId?"✏️ Edit Expense":"➕ Record Expense"}</h3>
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
      <div>
        <h2 className="font-bold text-lg text-slate-800">Income</h2>
        <p className="text-xs text-gray-400">All payments received across orders.</p>
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

      <div className="bg-gradient-to-r from-indigo-600 to-violet-600 rounded-2xl p-5 text-white flex items-center justify-between">
        <div>
          <p className="text-sm opacity-80">Total Received ({filtered.length} entries)</p>
          <p className="text-3xl font-black mt-1">&#x20B9;{total.toLocaleString("en-IN", {minimumFractionDigits:2})}</p>
        </div>
        <span className="text-5xl opacity-20">&#x20B9;</span>
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

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ orders, expenses, recipients, allRecipients=[], seller }) {
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

                  <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">
                      {s.net>0?`${s.name} owes company`:s.net<0?`Company owes ${s.name}`:"Settled"}
                    </span>
                    <span className={`text-sm font-black ${s.net>0?"text-emerald-600":s.net<0?"text-orange-500":"text-gray-400"}`}>
                      {s.net===0?"✓ Settled":`₹${fmt(Math.abs(s.net))}`}
                    </span>
                  </div>
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
      client.from("settings").select(),
    ]).then(([ord,qt,pf,ti,allItems,cl,rc,ex,pay,sets])=>{
      const parseJson = (v) => { if (typeof v==="string" && (v.startsWith("{")||v.startsWith("["))) { try{return JSON.parse(v)}catch(e){return v} } return v; };
      // Map DB item row to app item object
      const mapItem = (r) => ({ sl:r.sl, item:r.item||"", hsn:r.hsn||"", unit:r.unit||"Nos", unitPrice:r.unit_price, qty:r.qty, discount:r.discount, grossAmt:r.gross_amt, cgstRate:r.cgst_rate, cgstAmt:r.cgst_amt, sgstRate:r.sgst_rate, sgstAmt:r.sgst_amt, netAmt:r.net_amt });
      const getItems = (type, id) => (allItems||[]).filter(i=>i.document_type===type&&i.document_id===id).sort((a,b)=>a.sl-b.sl).map(mapItem);
      const mapOrder = (r) => ({ orderNo:r.order_no, orderNoBase:r.order_no_base, type:r.type, customerName:r.customer_name, phone:r.phone, email:r.email, gstin:r.gstin, billingName:r.billing_name, billingAddress:r.billing_address, billingStateCode:r.billing_state_code, shippingName:r.shipping_name, shippingAddress:r.shipping_address, shippingContact:r.shipping_contact, shippingGstin:r.shipping_gstin, shippingStateCode:r.shipping_state_code, placeOfSupply:r.place_of_supply, orderDate:r.order_date, dueDate:r.due_date, paymentMode:r.payment_mode, advance:r.advance, advanceRecipient:r.advance_recipient, advanceTxnRef:r.advance_txn_ref, status:r.status, comments:r.comments, needsGst:r.needs_gst, quotationNo:r.quotation_no, proformaIds:parseJson(r.proforma_ids)||[], taxInvoiceIds:parseJson(r.tax_invoice_ids)||[], items:getItems("order",r.order_no), payments:[] });
      const mapInv = (type) => (r) => ({ invNo:r.inv_no, invNoBase:r.inv_no_base, invDate:r.inv_date, orderId:r.order_id, amount:r.amount, notes:r.notes||"", items:getItems(type,r.inv_no), sellerSnapshot: r.seller_snapshot ? (()=>{try{return JSON.parse(r.seller_snapshot)}catch(e){return null}})() : null });
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
      if (ex?.length) setExpenses(ex.map(mapExpense).filter(e=>!e.isDeleted));
      if (sets?.length) {
        const s = {}; sets.forEach(r=>{ try{s[r.key]=JSON.parse(r.value)}catch(e){s[r.key]=r.value} });
        if (s.seller) setSeller(s.seller);
        if (s.series) setSeries(s.series);
      }
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
        else if (job.action==="saveSettings") {
          for (const [k,v] of Object.entries(job.data)) {
            await sb().from("settings").upsert({key:k, value: typeof v==="object"?JSON.stringify(v):String(v)});
          }
        }
      }
      setSyncStatus("saved");
    } catch(e) {
      setSyncStatus("error");
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
      sgst_rate: it.sgstRate||0, sgst_amt: it.sgstAmt||0, net_amt: it.netAmt||0
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
      tax_invoice_ids:JSON.stringify(o.taxInvoiceIds||[])
    }});
    syncItems("order", o.orderNo, o.items);
  };
  const upsertQuotation = (q) => {
    enqueue({action:"upsert",table:"quotations",row:{
      inv_no:q.invNo, inv_no_base:q.invNoBase, inv_date:q.invDate,
      order_id:q.orderId, amount:q.amount||0, notes:q.notes||"",
      seller_snapshot: q.sellerSnapshot ? JSON.stringify(q.sellerSnapshot) : null
    }});
    syncItems("quotation", q.invNo, q.items);
  };
  const upsertProforma = (p) => {
    enqueue({action:"upsert",table:"proformas",row:{
      inv_no:p.invNo, inv_no_base:p.invNoBase, inv_date:p.invDate,
      order_id:p.orderId, amount:p.amount||0, notes:p.notes||"",
      seller_snapshot: p.sellerSnapshot ? JSON.stringify(p.sellerSnapshot) : null
    }});
    syncItems("proforma", p.invNo, p.items);
  };
  const upsertTaxInvoice = (t) => {
    enqueue({action:"upsert",table:"tax_invoices",row:{
      inv_no:t.invNo, inv_no_base:t.invNoBase, inv_date:t.invDate,
      order_id:t.orderId, amount:t.amount||0, notes:t.notes||"",
      seller_snapshot: t.sellerSnapshot ? JSON.stringify(t.sellerSnapshot) : null
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

  const tabs=[{id:"new",label:"New Order"},{id:"orders",label:"Orders"},{id:"clients",label:"Clients"},{id:"expenses",label:"Expenses"},{id:"income",label:"Income"},{id:"dashboard",label:"Splitwise"},{id:"settings",label:"Settings"}];

  if (!accessToken) return <LoginScreen onLogin={handleLogin} sbUrl={sbUrl} sbKey={sbKey}/>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 font-sans">
      <style>{`input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield}`}</style>
      <Toast toasts={toasts}/>
      {loading&&<div className="fixed inset-0 z-50 bg-white/80 flex items-center justify-center"><div className="text-center"><p className="text-2xl mb-2">⏳</p><p className="text-sm font-semibold text-indigo-600">Loading data from Supabase…</p></div></div>}
      <div className="bg-white border-b border-gray-100 shadow-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {seller.logo
              ? <img src={seller.logo} alt="logo" className="h-9 max-w-[120px] object-contain"/>
              : <span className="text-base font-black text-slate-800 tracking-tight">{seller.name||"Elace"}</span>
            }
            {syncStatus==="error"&&<span className="text-xs text-red-400">⚠ Sync failed</span>}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
              {tabs.map(t=><button key={t.id} onClick={()=>setTab(t.id)} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all whitespace-nowrap ${tab===t.id?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700"}`}>{t.label}</button>)}
            </div>
            {countdown!==null&&(
              <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
                <span className="text-xs font-semibold text-amber-600">⏱ Session expires in</span>
                <span className="text-sm font-black text-amber-700 tabular-nums min-w-[2.5rem] text-center">
                  {`${String(Math.floor(countdown/60)).padStart(2,"0")}:${String(countdown%60).padStart(2,"0")}`}
                </span>
              </div>
            )}
            <button onClick={handleLogout} className="ml-2 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold text-red-500 border border-red-200 hover:bg-red-50 transition-all">Sign Out</button>
          </div>
        </div>
      </div>
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 md:p-8">
          {tab==="new"&&<OrderForm orders={orders} setOrders={syncSetOrders} quotations={quotations} setQuotations={syncSetQuotations} proformas={proformas} setProformas={syncSetProformas} taxInvoices={taxInvoices} setTaxInvoices={syncSetTaxInvoices} seller={seller} series={series} clients={clients} recipients={recipients} onViewOrder={(o)=>{setViewOrder(o);setTab("orders");}} toast={toast}/>}
          {tab==="orders"&&<OrdersList orders={orders} setOrders={syncSetOrders} quotations={quotations} setQuotations={syncSetQuotations} proformas={proformas} setProformas={syncSetProformas} taxInvoices={taxInvoices} setTaxInvoices={syncSetTaxInvoices} seller={seller} series={series} recipients={recipients} allRecipients={allRecipientsRef.current} upsertPayment={upsertPayment} enqueue={enqueue} initialOrder={viewOrder} onClearInitialOrder={()=>setViewOrder(null)} toast={toast}/>}
          {tab==="clients"&&<ClientMaster clients={clients} setClients={syncSetClients} deleteClient={deleteClient} toast={toast}/>}
          {tab==="expenses"&&<ExpenseTracker expenses={expenses} setExpenses={syncSetExpenses} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller} deleteExpense={deleteExpense} toast={toast}/>}
          {tab==="income"&&<IncomeView orders={orders} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller}/>}
          {tab==="dashboard"&&<Dashboard orders={orders} expenses={expenses} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller}/>}
          {tab==="settings"&&<Settings sbUrl={sbUrl} setSbUrl={handleSetSbUrl} sbKey={sbKey} setSbKey={handleSetSbKey} seller={seller} setSeller={syncSetSeller} series={series} setSeries={syncSetSeries} recipients={recipients} setRecipients={syncSetRecipients} upsertRecipient={upsertRecipient} allRecipients={allRecipientsRef.current} toast={toast}/>}
        </div>
      </div>
    </div>
  );
}

export default App;
