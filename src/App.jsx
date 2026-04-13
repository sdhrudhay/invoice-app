import { useState, useEffect, useRef, useCallback } from "react";

// Safe env var access (works in Vite, CRA, and plain browser)
const getEnv = (key) => { try { return import.meta?.env?.[key] || ""; } catch(e) { return ""; } };

const hashPassword = async (pass) => {
  const enc = new TextEncoder().encode(pass);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
};

const ALL_TABS = ["analytics","new","orders","clients","expenses","income","dashboard","inventory","products","assets","salary","download","settings","admin"];
const DEFAULT_PERMS = Object.fromEntries(ALL_TABS.map(t=>[t,"none"]));
const TAB_SUBTABS = {
  orders: ["details","quotation","invoices","payments","filament"],
  expenses: ["expenses","categories"],
  download: ["invoices","reports","gstr1"],
  analytics: ["overview","trends","orders","finance","filament","customers","referrals"],
  income: ["payments","invoiced"],
};


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
  const base = period ? `${prefix}${period}` : prefix;
  const count = list.filter(i => i.invNoBase === base).length + 1;
  return { invNo: `${base}${String(count).padStart(digits, "0")}`, invNoBase: base };
}

function genClientId(clients=[]) {
  const n = clients.length + 1;
  return "CLT-" + String(n).padStart(4,"0");
}


const INDIA_STATES = [
  {code:"01",name:"Jammu & Kashmir"},{code:"02",name:"Himachal Pradesh"},{code:"03",name:"Punjab"},
  {code:"04",name:"Chandigarh"},{code:"05",name:"Uttarakhand"},{code:"06",name:"Haryana"},
  {code:"07",name:"Delhi"},{code:"08",name:"Rajasthan"},{code:"09",name:"Uttar Pradesh"},
  {code:"10",name:"Bihar"},{code:"11",name:"Sikkim"},{code:"12",name:"Arunachal Pradesh"},
  {code:"13",name:"Nagaland"},{code:"14",name:"Manipur"},{code:"15",name:"Mizoram"},
  {code:"16",name:"Tripura"},{code:"17",name:"Meghalaya"},{code:"18",name:"Assam"},
  {code:"19",name:"West Bengal"},{code:"20",name:"Jharkhand"},{code:"21",name:"Odisha"},
  {code:"22",name:"Chhattisgarh"},{code:"23",name:"Madhya Pradesh"},{code:"24",name:"Gujarat"},
  {code:"25",name:"Daman & Diu"},{code:"26",name:"Dadra & Nagar Haveli"},{code:"27",name:"Maharashtra"},
  {code:"28",name:"Andhra Pradesh (Old)"},{code:"29",name:"Karnataka"},{code:"30",name:"Goa"},
  {code:"31",name:"Lakshadweep"},{code:"32",name:"Kerala"},{code:"33",name:"Tamil Nadu"},
  {code:"34",name:"Puducherry"},{code:"35",name:"Andaman & Nicobar Islands"},{code:"36",name:"Telangana"},
  {code:"37",name:"Andhra Pradesh"},{code:"38",name:"Ladakh"},
];
const stateByCode = (code) => INDIA_STATES.find(s=>s.code===String(code).padStart(2,"0"))?.name || "";
const stateCodeLabel = (code) => { const s=INDIA_STATES.find(s=>s.code===String(code).padStart(2,"0")); return s?s.code+" - "+s.name:""; };
// Extract just the numeric code from any format: "29", "29 (Karnataka)", "Karnataka (29)", "29-Karnataka" etc.
const extractStateCode = (v) => { if(!v) return ""; const m=String(v).match(/\b(\d{1,2})\b/); return m?m[1].padStart(2,"0"):""; };


function StateSelect({ value, onChange, disabled=false, label="State/UT Code" }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</label>
      <select value={value||""} onChange={e=>onChange(e.target.value)} disabled={disabled}
        className={`border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white ${disabled?"opacity-60 cursor-not-allowed":""}`}>
        <option value="">— Select State/UT —</option>
        {INDIA_STATES.map(s=><option key={s.code} value={s.code}>{s.code} ({s.name})</option>)}
      </select>
    </div>
  );
}

const EMPTY_CLIENT = { id:"", name:"", gstin:"", contact:"", email:"", billingName:"", billingAddress:"", billingStateCode:"", placeOfSupply:"", shippingName:"", shippingContact:"", shippingGstin:"", shippingAddress:"", shippingStateCode:"", clientType:"B2B" };

const EMPTY_ITEM = { sl: 1, item: "", hsn: "", unit: "Nos", unitPrice: "", qty: 1, discount: 0, grossAmt: 0, cgstRate: 9, cgstAmt: 0, sgstRate: 9, sgstAmt: 0, netAmt: 0 };

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
const ONLINE_PLATFORMS = ["Website","Amazon","Flipkart","Meesho","Other"];
const channelBadge = (ch) => {
  if (!ch||ch==="Offline") return {icon:"🏪",label:"Offline",cls:"bg-gray-100 text-gray-600"};
  return {icon:"🌐",label:ch,cls:"bg-sky-100 text-sky-700"};
};

const DEFAULT_SELLER = {
  name: "Your Company Name", gstin: "29XXXXX0000X1ZX",
  address: "123, Business Park, Bengaluru, Karnataka - 560001",
  state: "Karnataka", stateCode: "29", phone: "+91 98765 43210",
  email: "billing@yourcompany.com", bank: "HDFC Bank",
  accountNo: "XXXXXXXXXXXX", ifsc: "HDFC0001234", logo: "",
  qtTerms: "1. This quotation is valid for 15 days from the date of issue.\n2. Prices are subject to change without prior notice.\n3. 50% advance payment required to confirm the order.\n4. Delivery timelines will be confirmed upon order confirmation.",
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
-- alter table orders add column if not exists is_pickup integer default 0;
-- alter table orders add column if not exists cancel_reason text default '';
-- alter table orders add column if not exists channel text default 'Offline';
-- ═══ User Management & Audit Log (run once in Supabase) ═══
-- create table if not exists app_users (
--   id text primary key,
--   username text unique not null,
--   password_hash text not null,
--   permissions jsonb default '{}',
--   is_active boolean default true,
--   created_at timestamptz default now()
-- );
-- create table if not exists app_sessions (
--   id text primary key,
--   user_id text not null,
--   username text not null,
--   login_at timestamptz default now(),
--   logout_at timestamptz,
--   ip text default ''
-- );
-- create table if not exists app_audit_log (
--   id text primary key,
--   user_id text not null,
--   username text not null,
--   action text not null,
--   tab text default '',
--   record_id text default '',
--   detail text default '',
--   ts timestamptz default now()
-- );
-- ═══════════════════════════════════════════════════════════════
-- alter table orders add column if not exists is_referred integer default 0;
-- alter table orders add column if not exists referral_person text default '';
-- alter table orders add column if not exists referral_amount numeric default 0;
-- alter table orders add column if not exists referral_paid integer default 0;
-- alter table orders add column if not exists referral_paid_date text default '';
-- alter table orders add column if not exists referral_paid_ref text default '';
-- alter table payments add column if not exists is_refund integer default 0;
-- alter table payments add column if not exists refund_to text default '';
-- create table if not exists employees (id text primary key, name text not null, role text default '', is_deleted boolean default false);
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
  const _billSCQ = orderArg.billingStateCode || order.billingStateCode;
  const _shipSCQ = orderArg.shippingStateCode || order.shippingStateCode;
  const _igstStateQ = order.type==="B2B" ? _billSCQ : (_shipSCQ || _billSCQ);
  const _pickupQ = orderArg.isPickup !== undefined ? orderArg.isPickup : order.isPickup;
  const isIgst = !_pickupQ && ng && seller.stateCode && _igstStateQ && extractStateCode(_igstStateQ) !== extractStateCode(seller.stateCode);
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
  th{background:#fff;color:#000;padding:7px 8px;text-align:center;font-weight:700;white-space:nowrap;border-bottom:2px solid #000}
  td{padding:5px 8px;border-bottom:1px solid #000;text-align:center;color:#000}
  .sr td{background:#f0f0f0;font-weight:600;border-bottom:1px solid #000}.gr td{background:#fff;color:#000;font-weight:700;font-size:12px;border-bottom:2px solid #000;border-top:1px solid #000}
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
<div class="box" style="margin:10px 0;font-size:11px;line-height:1.8">
  <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:#555;letter-spacing:0.05em">Customer</span><br>
  <b>${order.billingName||order.customerName}</b>${order.type==="B2B"?` &nbsp;|&nbsp; GSTIN: ${order.gstin||"-"}`:""}<br>
  <span style="font-size:10px;color:#555"><b>Contact:</b> ${order.phone||order.contact||"-"}</span>
</div>
<table><thead><tr>
  <th>#</th><th>Item / Description</th><th>HSN</th>
  <th>Unit Price</th><th>Qty</th><th>Disc%</th><th>Gross</th>
  ${ng?(isIgst?`<th>IGST%</th><th>IGST</th>`:`<th>CGST%</th><th>CGST</th><th>SGST%</th><th>SGST</th>`):""}
  <th>Net Amount</th>
</tr></thead><tbody>
${items.map((it,i)=>`<tr><td>${i+1}</td><td style="max-width:220px;word-break:break-word;white-space:normal;text-align:left">${it.item}</td><td>${it.hsn||"-"}</td>
  <td>₹${fmt(it.unitPrice)}</td><td>${it.qty}</td><td>${it.discount||0}%</td><td>₹${fmt(it.grossAmt)}</td>
  ${ng?(isIgst?`<td>${it.cgstRate+it.sgstRate}%</td><td>₹${fmt(it.cgstAmt+it.sgstAmt)}</td>`:`<td>${it.cgstRate}%</td><td>₹${fmt(it.cgstAmt)}</td><td>${it.sgstRate}%</td><td>₹${fmt(it.sgstAmt)}</td>`):""}
  <td><b>₹${fmt(it.netAmt)}</b></td></tr>`).join("")}
</tbody><tfoot>
  <tr class="sr"><td colspan="${ng?6:6}" style="text-align:right">Subtotals</td><td>₹${fmt(tG)}</td>${ng?(isIgst?`<td></td><td>₹${fmt(tC+tS)}</td>`:`<td></td><td>₹${fmt(tC)}</td><td></td><td>₹${fmt(tS)}</td>`):""}<td>₹${fmt(tN)}</td></tr>
  <tr class="gr"><td colspan="${cols-1}" style="text-align:right">GRAND TOTAL</td><td>₹${fmt(tN)}</td></tr>
</tfoot></table>
${inv.notes?`<div style="font-size:11px;color:#555;margin:8px 0"><b>Notes:</b> ${inv.notes}</div>`:""}
${seller.qtTerms?`<div style="margin-top:12px;padding:10px 12px;background:#f9f9f9;border:1px solid #eee;border-radius:5px;font-size:10px;color:#444;line-height:1.8"><b style="font-size:11px">Terms & Conditions</b><br>${(seller.qtTerms||"").replace(/\n/g,"<br>")}</div>`:`<div class="validity">This is a quotation only and not a tax invoice.</div>`}
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
  // For tax invoices, needsGst is always true by definition
  const ng = type==="tax" ? true : (orderArg.needsGst !== undefined ? orderArg.needsGst : order.needsGst);
  // Pickup = ONLY the explicit flag
  const _pickup = !!order.isPickup;
  // When pickup, place of supply = seller's state always
  const _placeOfSupply = _pickup ? (seller.state||seller.stateCode||"") : (order.placeOfSupply||"");
  // IGST: never on pickup; for B2B use billing state; for B2C use shipping state
  // For IGST: orderArg is the live "o" state — prefer it for state codes (not frozen snapshot)
  // orderSnapshot overwrites orderArg in `order` which may have empty state code from snapshot time
  const _billSC = orderArg.billingStateCode || order.billingStateCode;
  const _shipSC = orderArg.shippingStateCode || order.shippingStateCode;
  const _customerState = order.type==="B2B" ? _billSC : (_shipSC || _billSC);
  const isIgst = !_pickup && ng && seller.stateCode && _customerState && extractStateCode(_customerState) !== extractStateCode(seller.stateCode);
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
  th{background:#fff;color:#000;padding:7px 8px;text-align:center;font-weight:700;white-space:nowrap;border-bottom:2px solid #000}
  td{padding:5px 8px;border-bottom:1px solid #000;text-align:center;color:#000}
  .sr td{background:#f0f0f0;font-weight:600;border-bottom:1px solid #000}.gr td{background:#fff;color:#000;font-weight:700;font-size:12px;border-bottom:2px solid #000;border-top:1px solid #000}
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
    <div class="inv-meta"><b>Invoice #:</b> ${inv.invNo}<br><b>Date:</b> ${inv.invDate}<br><b>Order #:</b> ${order.orderNo}<br>${_placeOfSupply?`<b>Place of Supply:</b> ${_placeOfSupply}<br>`:""}</div>
  </div>
</div>
${_pickup
  ? `<div style="margin:10px 0;padding:9px 11px;border:1px solid #999;border-radius:5px;font-size:11px;line-height:1.8"><span style="font-size:10px;font-weight:700;text-transform:uppercase;color:#555;letter-spacing:0.05em">Customer</span><br><b>${order.billingName||order.customerName}</b>${order.phone||order.contact?`<br><span style="font-size:10px;color:#555"><b>Contact:</b> ${order.phone||order.contact}</span>`:""}<br><span style="font-size:10px;color:#777"><b>Place of Supply:</b> ${_placeOfSupply}</span></div>`
  : `<div class="two-col">
  <div class="box"><div class="bt">Bill To</div><b>${order.billingName||order.customerName}</b><br>${order.billingAddress||""}<br>${order.type==="B2B"?`GSTIN: ${order.gstin||"-"}<br>State Code: ${order.billingStateCode||"-"}<br>`:order.billingStateCode?`State Code: ${order.billingStateCode}<br>`:""}${order.phone||order.contact||""}</div>
  <div class="box"><div class="bt">Ship To</div><b>${order.shippingName||order.billingName||order.customerName}</b><br>${order.shippingAddress||order.billingAddress||""}<br>${(order.shippingGstin||order.gstin)?`GSTIN: ${order.shippingGstin||order.gstin}<br>`:""}${(order.shippingStateCode||order.billingStateCode)?`State Code: ${order.shippingStateCode||order.billingStateCode}<br>`:""}${order.shippingContact?`${order.shippingContact}<br>`:""}</div>
</div>`}
<table><thead><tr>
  <th>#</th><th>Item / Description</th><th>HSN</th>
  <th>Unit Price</th><th>Qty</th><th>Disc%</th><th>Gross</th>
  ${ng?(isIgst?`<th>IGST%</th><th>IGST</th>`:`<th>CGST%</th><th>CGST</th><th>SGST%</th><th>SGST</th>`):""}
  <th>Net Amount</th>
</tr></thead><tbody>
${items.map((it,i)=>`<tr><td>${i+1}</td><td style="max-width:220px;word-break:break-word;white-space:normal;text-align:left">${it.item}</td><td>${it.hsn||"-"}</td>
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
  const b = "border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 w-full " + (disabled ? "bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed select-none" : "bg-white border-gray-200");
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

function S({ label, value, onChange, options, className="", disabled=false }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {label && <label className={"text-xs font-semibold uppercase tracking-wide "+(disabled?"text-gray-300":"text-gray-500")}>{label}</label>}
      <select value={value} onChange={e=>!disabled&&onChange(e.target.value)} disabled={disabled} className={"border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 "+(disabled?"bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed":"bg-white border-gray-200")}>
        {options.map(o=><option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}
      </select>
    </div>
  );
}

// ─── Item Table ───────────────────────────────────────────────────────────────

function ProductPicker({ products, onSelect, rowIdx }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef();
  const btnRef = useRef();
  const [pos, setPos] = useState({top:0,left:0});

  useEffect(()=>{
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({top: r.bottom+4, left: r.left});
    const close = (e)=>{ if(ref.current&&!ref.current.contains(e.target)&&!btnRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return ()=>document.removeEventListener("mousedown", close);
  }, [open]);

  const filtered = products.filter(p=>!q||p.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="relative inline-block">
      <button ref={btnRef} type="button" onClick={()=>{ setQ(""); setOpen(v=>!v); }}
        className="border border-indigo-200 text-xs text-indigo-500 rounded px-1.5 py-0.5 bg-transparent hover:bg-indigo-50 whitespace-nowrap">
        + Product
      </button>
      {open&&(
        <div ref={ref} className="fixed z-[9999] bg-white border border-indigo-200 rounded-xl shadow-xl" style={{top:pos.top,left:pos.left,minWidth:"180px",maxHeight:"240px",display:"flex",flexDirection:"column"}}>
          <div className="p-1.5 border-b border-gray-100">
            <input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder="Search products…"
              className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"/>
          </div>
          <div className="overflow-y-auto">
            {filtered.length===0&&<p className="text-xs text-gray-400 px-3 py-2">No products found</p>}
            {filtered.map(p=>(
              <button key={p.id} type="button" onClick={()=>{ onSelect(p); setOpen(false); setQ(""); }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-indigo-50 text-gray-700">{p.name}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SpoolPicker({ spoolOptions, onSelect }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef();
  const btnRef = useRef();
  const [pos, setPos] = useState({top:0,left:0});

  useEffect(()=>{
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({top: r.bottom+4, left: r.left});
    const close = (e)=>{ if(ref.current&&!ref.current.contains(e.target)&&!btnRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return ()=>document.removeEventListener("mousedown", close);
  }, [open]);

  const filtered = spoolOptions.filter(sg=>{
    if (!q) return true;
    const s=q.toLowerCase();
    return [sg.brand,sg.material,sg.color].filter(Boolean).join(" ").toLowerCase().includes(s);
  });

  // Group by material
  const byMaterial = {};
  filtered.forEach(sg=>{ const m=sg.material||"Other"; if(!byMaterial[m])byMaterial[m]=[]; byMaterial[m].push(sg); });

  return (
    <div className="relative inline-block">
      <button ref={btnRef} type="button" onClick={()=>{ setQ(""); setOpen(v=>!v); }}
        className="border border-orange-200 text-xs text-orange-500 rounded px-1.5 py-0.5 bg-transparent hover:bg-orange-50 whitespace-nowrap">
        + Spool
      </button>
      {open&&(
        <div ref={ref} className="fixed z-[9999] bg-white border border-orange-200 rounded-xl shadow-xl" style={{top:pos.top,left:pos.left,minWidth:"220px",maxHeight:"280px",display:"flex",flexDirection:"column"}}>
          <div className="p-1.5 border-b border-gray-100">
            <input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder="Search brand, material, colour…"
              className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-orange-400"/>
          </div>
          <div className="overflow-y-auto">
            {filtered.length===0&&<p className="text-xs text-gray-400 px-3 py-2">No spools found</p>}
            {Object.entries(byMaterial).map(([mat,spools])=>(
              <div key={mat}>
                <p className="px-3 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-100">{mat}</p>
                {spools.map((sg,si)=>(
                  <button key={si} type="button" onClick={()=>{ onSelect(sg); setOpen(false); setQ(""); }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-orange-50">
                    <span className="font-semibold text-gray-700">{sg.brand||"—"}</span>
                    <span className="text-gray-400 mx-1">·</span>
                    <span className="text-gray-600">{sg.color||"—"}</span>
                    <span className="ml-1.5 text-gray-400 text-[10px]">{(Number(sg.weightG)/1000).toFixed(Number(sg.weightG)%1000===0?0:2)}kg ×{sg.count}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ItemTable({ items, setItems, needsGst, isIgst=false, products=[], seller={}, inventory=[], orders=[], wastageLog=[], currentOrderNo="", onSpoolAdded=null, onSpoolRemoved=null, onSpoolQtyChanged=null, readOnly=false }) {
  const upd = (i,f,v) => { if(readOnly)return; setItems(items.map((it,idx)=>idx===i?calcItem({...it,[f]:v},needsGst):it)); };
  const add = () => { if(readOnly)return; setItems([...items, {...EMPTY_ITEM, sl:items.length+1}]); };
  const del = (i) => {
    if(readOnly)return;
    const removed = items[i];
    if (removed?._spoolGroup && removed?._spoolId && onSpoolRemoved) onSpoolRemoved(removed._spoolId, removed._batchKey);
    setItems(items.filter((_,idx)=>idx!==i).map((it,idx)=>({...it,sl:idx+1})));
  };
  const tG=items.reduce((s,i)=>s+num(i.grossAmt),0), tC=items.reduce((s,i)=>s+num(i.cgstAmt),0), tS=items.reduce((s,i)=>s+num(i.sgstAmt),0), tN=items.reduce((s,i)=>s+num(i.netAmt),0);
  const filamentPrices = seller.filamentPrices || {};

  // Compute used-per-spool to know which spools are still full/available
  const spoolUsed = {};
  orders.forEach(o => {
    if (o.orderNo===currentOrderNo) return; // exclude current order
    (o.filamentUsage||[]).forEach(u => { spoolUsed[u.inventoryId]=(spoolUsed[u.inventoryId]||0)+Number(u.weightUsedG||0); });
  });
  wastageLog.forEach(w => {
    const groupSpools = inventory.filter(i=>`${i.brand||""}||${i.material}||${i.color||""}`===w.groupKey).sort((a,b)=>Number(b.weightG)-Number(a.weightG));
    let rem=Number(w.weightG||0);
    for(const s of groupSpools){ const take=Math.min(rem,Math.max(0,Number(s.weightG||0)-(spoolUsed[s.id]||0))); spoolUsed[s.id]=(spoolUsed[s.id]||0)+take; rem-=take; if(rem<=0)break; }
  });
  // Also count spools already added as items in the current order
  items.forEach(it => {
    if (it._spoolGroup && it._spoolId) {
      const _spoolW = Number(it._weightGPerSpool||0) || Number(inventory.find(s=>s.id===it._spoolId)?.weightG||0);
      spoolUsed[it._spoolId] = (spoolUsed[it._spoolId]||0) + _spoolW * Number(it.qty||1);
    }
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
    if (!spoolGroups[key]) spoolGroups[key] = { brand:s.brand, material:s.material, color:s.color, weightG:s.weightG, costTotal:s.costTotal, spoolIds:[] };
    spoolGroups[key].spoolIds.push(s.id);
  });
  const spoolOptions = Object.values(spoolGroups).map(g=>({...g, count:g.spoolIds.length}));

  const applySpoolToRow = (rowIdx, sg, spoolId) => {
    const name = [`${sg.brand||""}`, sg.material, sg.color, `${(Number(sg.weightG)/1000).toFixed(Number(sg.weightG)%1000===0?0:2)}kg`].filter(Boolean).join(' ');
    const unitPrice = sg.costTotal ? Math.round((Number(sg.costTotal)/1)*100)/100 : "";
    const batchKey = "BATCH-"+Date.now();
    setItems(items.map((it,idx)=>idx===rowIdx ? calcItem({...it, item:name, unit:"Nos", unitPrice, qty:1, _brand:sg.brand, _material:sg.material, _spoolGroup:true, _spoolId:spoolId, _spoolIds:sg.spoolIds, _spoolCount:sg.count, _weightGPerSpool:Number(sg.weightG||0), _batchKey:batchKey}, needsGst) : it));
    // Register ONE entry for the first spool (qty=1)
    if (onSpoolAdded) {
      onSpoolAdded({
        id: "FU-"+Date.now()+"-"+spoolId,
        inventoryId: spoolId,
        weightUsedG: Number(sg.weightG||0),
        isWaste: false,
        notes: "Sold as whole spool",
        groupKey: `${sg.brand||""}||${sg.material}||${sg.color||""}`,
        batchKey,
      });
    }
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
  const hdrs = ["#","Item / Description","HSN","Unit Price","Qty","Disc%",...(needsGst?(isIgst?["IGST%"]:["CGST%","SGST%"]):[]),"Gross",...(needsGst?(isIgst?["IGST"]:["CGST","SGST"]):[]),"Net Amt",""];
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100 scrollbar-none" style={{WebkitOverflowScrolling:"touch"}}>
      <table className="w-full text-xs border-collapse" style={{minWidth:needsGst?(isIgst?"880px":"1020px"):"680px"}}>
        <thead><tr className="bg-slate-800 text-white">{hdrs.map((h,i)=><th key={i} className="px-2 py-2.5 text-center font-semibold whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>
          {items.map((it,i)=>(
            <tr key={i} className="border-b border-gray-100 hover:bg-slate-50">
              <td className="px-2 py-1.5 text-gray-400 w-6 text-center">{it.sl}</td>
              <td className="px-2 py-1.5 max-w-[220px]">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1">
                    <input value={it.item} onChange={e=>upd(i,"item",e.target.value)} placeholder="Item name" className={inp+" w-full min-w-[80px]"}/>
                    {!readOnly&&products.length>0&&<ProductPicker products={products} onSelect={p=>applyProduct(i,p)} rowIdx={i}/>}
                    {!readOnly&&spoolOptions.length>0&&<SpoolPicker spoolOptions={spoolOptions} onSelect={sg=>applySpoolToRow(i,sg,sg.spoolIds[0])}/>}
                  </div>
                  {(it._brand||it._material)&&<span className="text-[10px] text-gray-400">{[it._brand,it._material].filter(Boolean).join(" · ")}</span>}
                </div>
              </td>
              <td className="px-2 py-1.5 text-center w-16"><input value={it.hsn} onChange={e=>upd(i,"hsn",e.target.value)} placeholder="HSN" className={inp+" w-full text-center"}/></td>

              <td className="px-2 py-1.5 text-center">
                <div className="relative flex items-center justify-center">
                  <input type="number" value={it.unitPrice} onChange={e=>{if(e.target.value!==""&&parseFloat(e.target.value)<0)return;upd(i,"unitPrice",e.target.value);}} onWheel={e=>e.target.blur()} inputMode="decimal" min="0" className={inp+" w-16 text-center"}/>
                  {!readOnly&&<button type="button" title="Calculate from filament weight"
                    onClick={(e)=>{ const r=e.currentTarget.getBoundingClientRect(); setItems(items.map((it2,idx)=>idx===i?{...it2,_calcOpen:!it2._calcOpen,_calcBrand:it2._brand||"",_calcMat:it2._material||FILAMENT_MATS[0]||"PLA",_calcG:"",_calcX:r.left,_calcY:r.top}:it2)); }}
                    className="absolute right-0 text-[10px] font-bold text-indigo-500 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded px-1 py-0.5 leading-none border border-indigo-200" >g→₹</button>}
                </div>
                {it._calcOpen&&(
                  <div className="fixed z-[9999] bg-white border border-indigo-200 rounded-xl shadow-xl p-3 space-y-1.5" style={{minWidth:"220px",top:(it._calcY||0)+24,left:Math.min((it._calcX||0)-180, window.innerWidth-240)}}>
                    <p className="text-[10px] font-bold text-indigo-600 uppercase tracking-wide">Calc from weight</p>
                    {(()=>{
                      const pricedBrands=[...new Set(Object.keys(filamentPrices).map(k=>k.split("||")[0]).filter(Boolean))];
                      return pricedBrands.length>0
                        ? <select value={it._calcBrand||""} onChange={e=>setItems(items.map((it2,idx)=>idx===i?{...it2,_calcBrand:e.target.value}:it2))}
                            className="w-full border border-gray-200 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400">
                            <option value="">Any brand</option>
                            {pricedBrands.map(b=><option key={b} value={b}>{b}</option>)}
                          </select>
                        : <input value={it._calcBrand||""} onChange={e=>setItems(items.map((it2,idx)=>idx===i?{...it2,_calcBrand:e.target.value}:it2))}
                            placeholder="Brand (optional)" className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"/>;
                    })()}
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
              <td className="px-2 py-1.5 text-center">{it._spoolGroup?(<div className="flex flex-col items-center gap-0"><input type="number" value={it.qty} onChange={e=>{const v=e.target.value;if(v===""){ upd(i,"qty",v); return; }const n=parseFloat(v);if(n<0)return;if(it._spoolCount&&n>it._spoolCount)return;upd(i,"qty",v);if(n===0&&it._spoolId&&onSpoolRemoved){onSpoolRemoved(it._spoolId,it._batchKey);}else if(n>0&&it._spoolId&&onSpoolQtyChanged){onSpoolQtyChanged(it._spoolId,n,it._weightGPerSpool,it._batchKey,it._spoolIds);}}} onWheel={e=>e.target.blur()} inputMode="decimal" min="0" max={it._spoolCount||undefined} className={inp+" w-14 text-center"}/>{it._spoolCount&&<span className="text-[9px] text-gray-300 leading-none">max {it._spoolCount}</span>}</div>):(<input type="number" value={it.qty} onChange={e=>{if(e.target.value!==""&&parseFloat(e.target.value)<0)return;upd(i,"qty",e.target.value);}} onWheel={e=>e.target.blur()} inputMode="decimal" min="0" className={inp+" w-14 text-center"}/>)}</td>
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
            <td colSpan={needsGst?(isIgst?7:8):6} className="px-2 py-2 text-right text-gray-400 text-xs">Totals →</td>
            <td className="px-2 py-2 text-right text-xs">₹{fmt(tG)}</td>
            {needsGst&&(isIgst
              ? <td className="px-2 py-2 text-right text-xs">₹{fmt(tC+tS)}</td>
              : <><td className="px-2 py-2 text-right text-xs">₹{fmt(tC)}</td><td className="px-2 py-2 text-right text-xs">₹{fmt(tS)}</td></>)}
            <td className="px-2 py-2 text-right text-sm font-bold text-slate-800">₹{fmt(tN)}</td>
            <td/>
          </tr>
        </tfoot>
      </table>
      {!readOnly&&<button onClick={add} className="m-3 text-xs text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-1"><span className="text-base font-bold">+</span> Add Item</button>}
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
              className="w-full text-left px-4 py-3 hover:bg-indigo-50 border-b border-gray-200 last:border-0 transition-colors">
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
function OrderForm({ orders, setOrders, quotations, setQuotations, proformas, setProformas, taxInvoices, setTaxInvoices, seller, series, clients, recipients=[], onViewOrder=()=>{}, toast=()=>{}, products=[], inventory=[], wastageLog=[] }) {
  const topRef = useRef(null);
  const [type,setType]=useState("B2B"); const [needsGst,setNeedsGst]=useState(true);
  const [customerName,setCustomerName]=useState(""); const [phone,setPhone]=useState(""); const [email,setEmail]=useState(""); const [gstin,setGstin]=useState("");
  const [billingName,setBillingName]=useState(""); const [billingAddress,setBillingAddress]=useState(""); const [billingStateCode,setBillingStateCode]=useState("");
  const [shippingName,setShippingName]=useState(""); const [shippingContact,setShippingContact]=useState(""); const [shippingAddress,setShippingAddress]=useState(""); const [shippingGstin,setShippingGstin]=useState(""); const [shippingStateCode,setShippingStateCode]=useState("");
  const [sameAsBilling,setSameAsBilling]=useState(false);
  const [placeOfSupply,setPlaceOfSupply]=useState(""); const [isPickup,setIsPickup]=useState(false); const [orderDate,setOrderDate]=useState(today()); const [dueDate,setDueDate]=useState(addDays(today(),30)); const [paymentMode,setPaymentMode]=useState("UPI"); const [advance,setAdvance]=useState(""); const [status,setStatus]=useState("Pending"); const [comments,setComments]=useState("");
  const [items,setItems]=useState([{...EMPTY_ITEM}]);
  const [advanceRecipient,setAdvanceRecipient]=useState("");
  const [advanceTxnRef,setAdvanceTxnRef]=useState("");
  const [channel,setChannel]=useState("Offline");
  const [isReferred,setIsReferred]=useState(false);
  const [referralPerson,setReferralPerson]=useState("");
  const [referralAmount,setReferralAmount]=useState("");
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
    const order = { orderNo, orderNoBase, type, customerName, phone, email, contact: phone, gstin, billingName, billingAddress, billingStateCode, shippingName, shippingAddress, shippingContact, shippingGstin, shippingStateCode, placeOfSupply, isPickup: !!(type==="B2C" && needsGst && isPickup), channel:channel||"Offline", orderDate, dueDate: dueDate||addDays(orderDate,30), paymentMode, advance, advanceRecipient, advanceTxnRef, status, comments, needsGst, items, quotationNo: qtNo, proformaIds:[], taxInvoiceIds:[], charges:[], isReferred:isReferred?1:0, referralPerson:referralPerson||"", referralAmount:Number(referralAmount)||0, referralPaid:0, referralPaidDate:"", referralPaidRef:"" };
    const qt = { invNo:qtNo, invNoBase:qtBase, invDate:orderDate, items:[...items.map(i=>({...i}))], notes:comments, orderId:orderNo, amount:items.reduce((s,i)=>s+num(i.netAmt),0), sellerSnapshot:{...seller}, orderSnapshot:{customerName,billingName,billingAddress,billingStateCode,gstin:gstin||"",phone:phone||"",shippingName,shippingAddress,shippingContact,shippingGstin,shippingStateCode,type,needsGst,placeOfSupply,isPickup:!!(type==="B2C"&&needsGst&&isPickup)} };
    setOrders(p=>[...p,order]);
    setQuotations(p=>[...p,qt]);
    setLastOrder(order);
    reset();
    setSaving(false);
    setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}), 100);
  };

  const reset = () => {
    setSelectedClient(null); setCustomerName(""); setPhone(""); setEmail(""); setGstin(""); setBillingName(""); setBillingAddress(""); setBillingStateCode(""); setShippingName(""); setShippingContact(""); setShippingAddress(""); setShippingGstin(""); setShippingStateCode(""); setSameAsBilling(false); setPlaceOfSupply(""); setOrderDate(today()); setDueDate(addDays(today(),30)); setAdvance(""); setAdvanceRecipient(""); setAdvanceTxnRef(""); setStatus("Pending"); setComments(""); setNeedsGst(true); setType("B2B"); setChannel("Offline"); setIsReferred(false); setReferralPerson(""); setReferralAmount(""); setItems([{...EMPTY_ITEM}]); setMsg("");
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <F label="Customer / Company Name" value={customerName} onChange={setCustomerName} required className="md:col-span-2 col-span-1"/>
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
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Sales Channel</label>
              <div className="flex gap-2">
                {["Offline","Online"].map(c=>(
                  <button key={c} type="button" onClick={()=>setChannel(c==="Offline"?"Offline":(channel==="Offline"||!ONLINE_PLATFORMS.includes(channel)?ONLINE_PLATFORMS[0]:channel))}
                    className={`flex-1 py-1.5 rounded-full text-sm font-semibold border-2 transition-all ${(c==="Offline"?channel==="Offline":channel!=="Offline")?"bg-sky-600 border-sky-600 text-white":"border-gray-300 text-gray-500 hover:border-sky-400"}`}>{c==="Offline"?"🏪 Offline":"🌐 Online"}</button>
                ))}
              </div>
              {channel!=="Offline"&&<div className="flex gap-2 flex-wrap mt-1">
                {ONLINE_PLATFORMS.map(p=>(
                  <button key={p} type="button" onClick={()=>setChannel(p)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition-all ${channel===p?"bg-sky-100 border-sky-400 text-sky-700":"border-gray-200 text-gray-500 hover:border-sky-300"}`}>{p}</button>
                ))}
              </div>}
            </div>
          </div>
          {type==="B2C"&&needsGst&&<div className="flex items-center gap-2 pt-2">
            <input type="checkbox" id="pickup-chk" checked={isPickup} onChange={e=>{setIsPickup(e.target.checked);if(e.target.checked){setPlaceOfSupply(stateByCode(seller?.stateCode)||seller?.state||"");}}} className="rounded accent-indigo-600 w-4 h-4"/>
            <label htmlFor="pickup-chk" className="text-sm font-semibold text-gray-700 cursor-pointer">Office Pickup <span className="font-normal text-gray-400 text-xs">(customer collects from your office — no address needed)</span></label>
          </div>}
          {(!isPickup||type==="B2B")&&(
          <div className="border-t pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Billing Address</p>
            <div className="flex flex-col gap-3">
              <F label="Name on Invoice" value={billingName} onChange={setBillingName} placeholder={customerName}/>
              <StateSelect value={billingStateCode} onChange={v=>{ setBillingStateCode(v); if(type==="B2B") setPlaceOfSupply(stateByCode(v)); }}/>
              <F label="Billing Address" value={billingAddress} onChange={setBillingAddress} rows={2} className="md:col-span-2"/>
            </div>
          </div>
          )}
          {(!isPickup||type==="B2B")&&(
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
            <div className="flex flex-col gap-3">
              <F label="Name" value={sameAsBilling ? (billingName||customerName) : shippingName} onChange={v=>{if(!sameAsBilling)setShippingName(v);}} disabled={sameAsBilling}/>
              <F label="Contact Number" value={sameAsBilling ? phone : shippingContact} onChange={v=>{if(!sameAsBilling)setShippingContact(v);}} disabled={sameAsBilling} placeholder="+91 XXXXX XXXXX"/>
              {type==="B2B"&&<F label="GSTIN (if different)" value={sameAsBilling ? gstin : shippingGstin} onChange={v=>{if(!sameAsBilling)setShippingGstin(v);}} disabled={sameAsBilling}/>}
              <StateSelect value={sameAsBilling ? billingStateCode : shippingStateCode} onChange={v=>{ if(!sameAsBilling){ setShippingStateCode(v); if(type==="B2C") setPlaceOfSupply(stateByCode(v)); } }} disabled={sameAsBilling}/>
              <F label="Shipping Address" value={sameAsBilling ? billingAddress : shippingAddress} onChange={v=>{if(!sameAsBilling)setShippingAddress(v);}} disabled={sameAsBilling} rows={2}/>
            </div>
          </div>
          )}
          {needsGst&&<div className="flex flex-col gap-1 w-full md:w-64">
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Place of Supply</label>
            <div className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600">{placeOfSupply||<span className="text-gray-400 italic">Auto-filled from state code</span>}</div>
          </div>}
          <div className="border-t pt-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Order Items</p>
            <p className="text-xs text-gray-400 mb-3">These items form the basis of the quotation and all future invoices.</p>
            <ItemTable items={items} setItems={setItems} needsGst={needsGst} isIgst={needsGst&&!isPickup&&seller?.stateCode&&!!(type==="B2B"?billingStateCode:(shippingStateCode||billingStateCode))&&extractStateCode(type==="B2B"?billingStateCode:(shippingStateCode||billingStateCode))!==extractStateCode(seller.stateCode)} products={products} seller={seller} inventory={inventory} orders={orders} wastageLog={wastageLog} currentOrderNo=""/>
          </div>
          <F label="Comments / Notes" value={comments} onChange={setComments} rows={2}/>
          <div className="border border-dashed border-indigo-200 rounded-xl p-3 bg-indigo-50/40 space-y-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={isReferred} onChange={e=>setIsReferred(e.target.checked)} className="rounded"/>
              <span className="text-xs font-semibold text-indigo-700">🤝 Referred Order?</span>
            </label>
            {isReferred&&<div className="flex flex-col md:flex-row gap-2">
              <F label="Referred by" value={referralPerson} onChange={setReferralPerson} placeholder="Person / company name" className="flex-1"/>
              <F label="Referral Amount (₹)" value={referralAmount} onChange={setReferralAmount} placeholder="0" className="md:w-40"/>
            </div>}
          </div>
          <div className="flex flex-col gap-2 pt-2 border-t">
            <button onClick={handleSave} disabled={saving}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-bold text-sm disabled:opacity-50 transition-all">
              {saving?"Saving…":"Save Order & Generate Quotation"}
            </button>
            <div className="flex gap-2 items-center">
              <button onClick={reset} className="flex-1 border border-gray-200 text-gray-500 hover:bg-gray-50 py-2.5 rounded-lg text-sm font-medium">Clear</button>
              <div className="flex-1 text-xs text-gray-400 bg-gray-50 border rounded-lg px-3 py-2.5 font-mono text-center">Next: <span className="font-bold text-indigo-600">{previewNo}</span></div>
            </div>
          </div>
      </div>
    </div>
  );
}

// ─── Order Detail / Edit Drawer ───────────────────────────────────────────────

// ─── Filament Usage Tab ───────────────────────────────────────────────────────
function FilamentUsageTab({ filamentUsage=[], setFilamentUsage, inventory=[], newUsage, setNewUsage, onSave, toast=()=>{}, orders=[], currentOrderNo="", wastageLog=[], onAddWastage=()=>{}, readOnly=false }) {
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
    if (!newUsage.spoolId) { toast("Select a spool","error"); return; }
    if (!newUsage.weightUsedG || isNaN(Number(newUsage.weightUsedG)) || Number(newUsage.weightUsedG)<=0) { toast("Enter weight used","error"); return; }
    const need = Number(newUsage.weightUsedG);
    const spool = inventory.find(i=>i.id===newUsage.spoolId);
    if (!spool) { toast("Spool not found","error"); return; }
    const spoolRemaining = getRemainingG(spool.id)??0;
    if (need > spoolRemaining + 0.05) { toast(`Only ${spoolRemaining.toFixed(0)}g remaining on this spool`,"error"); return; }
    const batchKey = "BATCH-"+Date.now();
    const newEntries = [{
      id:"FU-"+Date.now()+"-"+spool.id,
      inventoryId: spool.id,
      weightUsedG: Math.round(need*10)/10,
      isWaste: newUsage.isWaste,
      notes: newUsage.notes||"",
      groupKey: newUsage.groupKey,
      batchKey,
    }];
    if (newEntries.length===0) { toast("No stock remaining in this filament group","error"); return; }
    if (newUsage.isWaste) {
      // Waste: store ONLY in wastageLog — not in filamentUsage — to avoid double-counting
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
      setNewUsage({groupKey:"", weightUsedG:"", isWaste:false, notes:"", spoolId:""});
      toast("Wastage recorded");
    } else {
      // Normal usage: store in filamentUsage on the order
      const updated = [...filamentUsage, ...newEntries];
      setFilamentUsage(updated);
      setNewUsage({groupKey:"", weightUsedG:"", isWaste:false, notes:"", spoolId:""});
      onSave(updated);
      toast("Filament usage recorded");
    }
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
  // Only standalone wastage (no orderNo) — order-linked waste already in usedPerSpool via filamentUsage
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
      {filamentUsage.filter(u=>!u.isWaste).length>0&&(()=>{
        // Group non-waste entries by material for breakdown
        const matMap = {};
        filamentUsage.filter(u=>!u.isWaste).forEach(u=>{
          const inv = inventory.find(i=>i.id===u.inventoryId);
          const mat = inv?.material||"Unknown";
          matMap[mat]=(matMap[mat]||0)+Number(u.weightUsedG||0);
        });
        const mats = Object.entries(matMap).sort((a,b)=>b[1]-a[1]);
        return (
          <div className="space-y-2">
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3">
              <p className="text-xs text-indigo-400 mb-0.5 font-semibold uppercase tracking-wide">Total Filament Used</p>
              <p className="text-2xl font-black text-indigo-700">{totalUsed.toFixed(1)} g</p>
              {mats.length>1&&<div className="flex flex-wrap gap-1.5 mt-2">
                {mats.map(([mat,g])=>(
                  <span key={mat} className="text-[10px] px-2 py-0.5 bg-indigo-100 text-indigo-600 rounded-full font-semibold">{mat}: {g.toFixed(1)} g</span>
                ))}
              </div>}
            </div>
          </div>
        );
      })()}

      {/* Wastage summary — from wastageLog linked to this order */}
      {(()=>{
        const orderWaste = wastageLog.filter(w=>w.orderNo===currentOrderNo);
        const orderWasteG = orderWaste.reduce((s,w)=>s+Number(w.weightG||0),0);
        if (orderWasteG<=0) return null;
        const byMat = {};
        orderWaste.forEach(w=>{ byMat[w.material||"Unknown"]=(byMat[w.material||"Unknown"]||0)+Number(w.weightG||0); });
        return (
          <div className="bg-orange-50 border border-orange-100 rounded-xl px-4 py-3">
            <p className="text-xs text-orange-400 mb-0.5 font-semibold uppercase tracking-wide">Order Wastage</p>
            <p className="text-2xl font-black text-orange-600">{orderWasteG.toFixed(1)} g</p>
            {Object.keys(byMat).length>1&&<div className="flex flex-wrap gap-1.5 mt-2">
              {Object.entries(byMat).sort((a,b)=>b[1]-a[1]).map(([mat,g])=>(
                <span key={mat} className="text-[10px] px-2 py-0.5 bg-orange-100 text-orange-600 rounded-full font-semibold">{mat}: {g.toFixed(1)} g</span>
              ))}
            </div>}
          </div>
        );
      })()}

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
                    <button key={key} type="button" onClick={()=>{ upd("groupKey", isSelected?"":key); upd("spoolId",""); }}
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
        {/* Spool picker — shown when a group is selected */}
        {newUsage.groupKey&&(()=>{
          const groupSpools = inventory
            .filter(i=>`${i.brand||""}||${i.material}||${i.color||""}`===newUsage.groupKey)
            .map(spool=>({...spool, remaining: getRemainingG(spool.id)??0}))
            .filter(s=>s.remaining>0)
            .sort((a,b)=>a.purchaseDate?.localeCompare(b.purchaseDate||"")||0);
          return groupSpools.length===0 ? (
            <p className="text-xs text-red-400">No stock remaining in this group.</p>
          ) : (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-gray-500">Select Spool</label>
              <div className="space-y-1">
                {groupSpools.map(spool=>{
                  const pct = Math.round(spool.remaining/Number(spool.weightG||1)*100);
                  const barC = pct>50?"bg-emerald-400":pct>20?"bg-amber-400":"bg-red-400";
                  const textC = pct>50?"text-emerald-600":pct>20?"text-amber-500":"text-red-500";
                  const isSelected = newUsage.spoolId===spool.id;
                  return (
                    <button key={spool.id} type="button" onClick={()=>upd("spoolId", isSelected?"":spool.id)}
                      className={`w-full text-left rounded-lg px-3 py-2 border text-xs transition-all ${isSelected?"border-indigo-400 bg-indigo-50 ring-1 ring-indigo-300":"border-gray-200 bg-white hover:border-indigo-200"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-gray-600 font-mono">{spool.purchaseDate||"—"}</span>
                        <span className={`font-bold ${textC}`}>{spool.remaining.toFixed(0)}g / {(Number(spool.weightG)/1000).toFixed(Number(spool.weightG)%1000===0?0:2)}kg left</span>
                      </div>
                      <div className="mt-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${barC}`} style={{width:`${pct}%`}}/>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
        {!readOnly&&<button onClick={handleAdd} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">
          + Add
        </button>}
      </div>

      {/* Usage list */}
      {filamentUsage.length===0&&wastageLog.filter(w=>w.orderNo===currentOrderNo).length===0&&(
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
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-1.5 flex-wrap min-w-0">
                          {fi&&<span className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${matColors[fi.material]||"bg-gray-100 text-gray-600"}`}>{fi.material}</span>}
                          <span className="text-xs font-semibold text-slate-700 min-w-0 break-words">{fi?`${fi.brand||"No brand"} · ${fi.color||"No colour"}`:"Unknown"}</span>
                          {isWaste&&<span className="shrink-0 text-[10px] bg-orange-100 text-orange-600 font-semibold px-1.5 py-0.5 rounded-full">Waste</span>}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-xs font-bold text-indigo-700">{d.totalG.toFixed(1)} g total</span>
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
                          ? <><span className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${matColors[item.material]||"bg-gray-100 text-gray-600"}`}>{item.material}</span>
                             <span className="text-xs font-semibold text-slate-700 min-w-0 break-words">{item.brand||"No brand"} · {item.color||"No colour"}</span></>
                          : <span className="text-xs text-gray-400 italic">Spool not found</span>
                        }
                        {isWaste&&<span className="shrink-0 text-[10px] bg-orange-100 text-orange-600 font-semibold px-1.5 py-0.5 rounded-full">Waste</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-xs font-bold text-indigo-700">{Number(u.weightUsedG).toFixed(1)} g</span>
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

function OrderEditDrawer({ order, quotations, proformas, taxInvoices, seller, series, onClose, onSaveOrder, onSaveInvoice, onCreateInvoice, onDeleteOrder=()=>{}, onDeleteInvoice=()=>{}, recipients=[], allRecipients=[], toast=()=>{}, inventory=[], orders=[], wastageLog=[], setWastageLog=()=>{}, products=[], enqueue=()=>{}, onReferralPaidChange=()=>{}, canSubTabRead=()=>true, canSubTabWrite=()=>true }) {
  const ORDER_SUBTABS = ["details","quotation","invoices","payments","filament"];
  const firstAccessible = ORDER_SUBTABS.find(st=>canSubTabRead(st)) || "details";
  const [tab, setTab] = useState(firstAccessible);
  const [o, setO] = useState({...order});
  const [creating, setCreating] = useState(null); // "proforma" | "tax"
  const [payments, setPayments] = useState(order.payments||[]);
  const [newPay, setNewPay] = useState({date:today(), amount:"", mode:"UPI", receivedBy:"", txnRef:"", comments:"", isRefund:false, refundTo:""});
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
  // Merge o (live edits) with order (saved) — o wins for edits, order fills gaps
  const _scFromO = o.type==="B2B"
    ? (o.billingStateCode||order.billingStateCode)
    : (o.shippingStateCode||order.shippingStateCode||o.billingStateCode||order.billingStateCode);
  const _pickupFromO = o.isPickup !== undefined ? o.isPickup : order.isPickup;
  // hasTaxInv must be declared before effectiveNeedsGst which depends on it
  const hasTaxInv = taxInvoices.some(t=>t.orderId===order.orderNo);
  const locked = hasTaxInv || o.status==="Completed" || o.status==="Cancelled";
  const statusLocked = !canSubTabWrite("details"); // status only locked by permissions
  const saveLocked   = !canSubTabWrite("details"); // save blocked only by permissions, not order state
  // Per-sub-tab locked: order-level lock OR no write permission on that sub-tab
  const detailsLocked  = locked || !canSubTabWrite("details");
  const quotLocked     = !canSubTabWrite("quotation"); // only locked by permissions
  const invLocked      = locked || !canSubTabWrite("invoices"); // creating new inv still blocked when locked
  const canDeleteInv   = canSubTabWrite("invoices"); // delete always allowed regardless of lock
  const payLocked      = !canSubTabWrite("payments"); // only locked by permissions
  const filamentLocked = !canSubTabWrite("filament"); // only locked by permissions
  const effectiveNeedsGst = !!(o.needsGst ?? order.needsGst) || hasTaxInv;
  const isIgst = !_pickupFromO && effectiveNeedsGst && seller?.stateCode && _scFromO && extractStateCode(_scFromO) !== extractStateCode(seller.stateCode);
  const qt = quotations.find(q=>q.orderId===order.orderNo);
  const initItems = (items) => {
    const effGst = !!(order.needsGst || hasTaxInv);
    return (items||[]).map(i =>
      effGst && num(i.cgstAmt)===0 && num(i.sgstAmt)===0 && num(i.cgstRate)>0
        ? calcItem(i, true)
        : {...i}
    );
  };
  const [orderItems, setOrderItems] = useState(initItems(order.items));
  // Sync orderItems when order.items prop changes (e.g. after initial load from Supabase)
  const prevOrderNo = useRef(order.orderNo);
  useEffect(() => {
    if (prevOrderNo.current !== order.orderNo) {
      // Different order opened — re-init everything from prop
      setOrderItems(initItems(order.items));
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
    if (saveLocked && updatedFilamentUsage === undefined) return; // block save for read-only (permissions only)
    const fu = updatedFilamentUsage !== undefined ? updatedFilamentUsage : filamentUsage;
    // Each spool item now has its own filamentUsage entry — no weight mutation needed
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
    const saved = {...updatedInv, amount:updatedInv.items.reduce((s,i)=>s+num(i.netAmt),0)+(updatedInv.charges||[]).reduce((s,c)=>s+num(c.amount),0), sellerSnapshot: updatedInv.sellerSnapshot || origInv?.sellerSnapshot, orderSnapshot: updatedInv.orderSnapshot || origInv?.orderSnapshot};
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
    setNewPay({date:today(), amount:"", mode:"UPI", receivedBy:"", txnRef:"", comments:"", isRefund:false, refundTo:""});
    toast("Payment added");
  };
  const handleDeletePayment = (id) => {
    const updated = payments.filter(p=>p.id!==id);
    setPayments(updated);
    enqueue({action:"delete", table:"payments", col:"id", val:String(id)});
    onSaveOrder({...o, items: orderItems, payments: updated});
  };
  const handleSaveNew = (inv, type) => {
    const needsGstNow = type==="tax" && order.type==="B2C" && !order.needsGst ? true : undefined;
    // Use live local state `o` (not prop `order`) so unsaved address/pickup edits are captured
    const snapOrder = o || order;
    const newInv = {...inv, orderId:snapOrder.orderNo, amount:inv.items.reduce((s,i)=>s+num(i.netAmt),0)+(inv.charges||[]).reduce((s,c)=>s+num(c.amount),0), sellerSnapshot:{...seller}, orderSnapshot:{customerName:snapOrder.customerName,billingName:snapOrder.billingName,billingAddress:snapOrder.billingAddress,billingStateCode:snapOrder.billingStateCode,gstin:snapOrder.gstin||"",phone:snapOrder.phone||snapOrder.contact||"",shippingName:snapOrder.shippingName,shippingAddress:snapOrder.shippingAddress,shippingContact:snapOrder.shippingContact,shippingGstin:snapOrder.shippingGstin,shippingStateCode:snapOrder.shippingStateCode,type:snapOrder.type,needsGst:type==="tax"?true:snapOrder.needsGst,placeOfSupply:snapOrder.placeOfSupply,isPickup:!!snapOrder.isPickup}};
    onCreateInvoice(newInv, type, null, needsGstNow);
    if (needsGstNow) setO(p=>({...p, needsGst:true}));
    setCreating(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" onClick={onClose}/>
      {/* Drawer */}
      <div className="w-full md:max-w-2xl bg-white shadow-2xl flex flex-col">
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
        <div className="flex border-b shrink-0 bg-gray-50 overflow-x-auto scrollbar-none" style={{WebkitOverflowScrolling:"touch"}}>
          {[["details","Order"],["quotation","Quotation"],["invoices","Invoices"],["payments","Payments"],["filament","Filament"]].filter(([id])=>canSubTabRead(id)).map(([id,label])=>(
            <button key={id} onClick={()=>{setTab(id);setCreating(null);}}
              className={`flex-1 text-center py-2.5 text-xs font-semibold border-b-2 transition-all whitespace-nowrap shrink-0 ${tab===id?"border-indigo-600 text-indigo-700 bg-white":"border-transparent text-gray-500"}`}>
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 md:space-y-5">

          {tab==="details" && canSubTabRead("details") && (
            <>
              {detailsLocked&&(
                <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                  <span className="text-xl shrink-0">🔒</span>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-amber-800">Order is locked</p>
                    <p className="text-xs text-amber-600 mt-0.5">
                      {hasTaxInv
                        ? "A Tax Invoice has been generated. Delete the tax invoice first to edit this order."
                        : !canSubTabWrite("details")?"This sub-tab is read-only. Contact admin to grant write access."
                        : o.status==="Cancelled"?"Order is Cancelled. Change status to edit fields.":"Order is Completed. Change status back to Pending to edit fields."}
                    </p>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <F label="Customer / Company Name" value={o.customerName} onChange={v=>upd("customerName",v)} disabled={detailsLocked} className="col-span-2 md:col-span-1"/>
                <F label="Phone" value={o.phone||o.contact||""} onChange={v=>upd("phone",v)} disabled={detailsLocked} placeholder="+91 XXXXX XXXXX"/>
                <F label="Email" value={o.email||""} onChange={v=>upd("email",v)} disabled={detailsLocked} placeholder="customer@email.com"/>
                {o.type==="B2B"&&<F label="GSTIN" value={o.gstin||""} onChange={v=>upd("gstin",v)} disabled={detailsLocked}/>}
                <F label="Order Date" type="date" value={o.orderDate} onChange={v=>upd("orderDate",v)} disabled={detailsLocked}/>
                <F label="Due Date" type="date" value={o.dueDate||""} onChange={v=>upd("dueDate",v)} disabled={detailsLocked}/>
                <S label="Payment Mode" value={o.paymentMode} onChange={v=>upd("paymentMode",v)} options={PAYMENT_MODES} disabled={detailsLocked}/>
                <F label="Advance Paid (₹)" type="number" value={o.advance||""} onChange={v=>upd("advance",v)} disabled={detailsLocked}/>
                <F label="Advance Txn Ref (optional)" value={o.advanceTxnRef||""} onChange={v=>upd("advanceTxnRef",v)} disabled={detailsLocked} placeholder="UPI ref, cheque no…"/>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Advance Received By</label>
                  <select value={o.advanceRecipient||""} onChange={e=>!detailsLocked&&upd("advanceRecipient",e.target.value)} disabled={detailsLocked} className={"border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 "+(detailsLocked?"bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed":"bg-white border-gray-200")}>
                    <option value="">— Select recipient —</option>
                    <option value="__company__">{seller?.name||"Company"}</option>{recipients.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
                <S label="Order Status" value={o.status} onChange={v=>upd("status",v)} options={STATUS_OPTIONS} disabled={statusLocked}/>
                <div className="flex flex-col gap-1 col-span-2">
                  <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Sales Channel</label>
                  <div className="flex gap-2">
                    {["Offline","Online"].map(c=>(
                      <button key={c} type="button" onClick={()=>!detailsLocked&&upd("channel",c==="Offline"?"Offline":((o.channel||"Offline")==="Offline"?ONLINE_PLATFORMS[0]:o.channel))} disabled={detailsLocked}
                        className={`flex-1 py-1.5 rounded-full text-sm font-semibold border-2 transition-all ${(c==="Offline"?(o.channel||"Offline")==="Offline":(o.channel||"Offline")!=="Offline")?"bg-sky-600 border-sky-600 text-white":"border-gray-300 text-gray-500 hover:border-sky-400"}`}>{c==="Offline"?"🏪 Offline":"🌐 Online"}</button>
                    ))}
                  </div>
                  {(o.channel||"Offline")!=="Offline"&&<div className="flex gap-2 flex-wrap mt-1">
                    {ONLINE_PLATFORMS.map(p=>(
                      <button key={p} type="button" onClick={()=>!detailsLocked&&upd("channel",p)} disabled={detailsLocked}
                        className={`px-3 py-1 rounded-full text-xs font-semibold border transition-all ${o.channel===p?"bg-sky-100 border-sky-400 text-sky-700":"border-gray-200 text-gray-500 hover:border-sky-300"}`}>{p}</button>
                    ))}
                  </div>}
                </div>
                {o.status==="Cancelled"&&<F label="Reason for Cancellation" value={o.cancelReason||""} onChange={v=>upd("cancelReason",v)} placeholder="e.g. Customer changed mind, Out of stock…" className="col-span-2"/>}
              </div>
              {o.type==="B2C"&&<label className={"flex items-center gap-2 text-sm text-gray-600 mt-1 "+(detailsLocked?"opacity-50 cursor-not-allowed":"cursor-pointer")}>
                <input type="checkbox" checked={!!o.isPickup} onChange={e=>{ if(detailsLocked)return; upd("isPickup",e.target.checked); if(e.target.checked) upd("placeOfSupply",stateByCode(extractStateCode(seller?.stateCode))||seller?.state||""); }} disabled={detailsLocked} className="rounded accent-indigo-600 w-4 h-4"/>
                <span className="font-semibold text-gray-700">Office Pickup <span className="font-normal text-gray-400 text-xs">(customer collects — CGST+SGST, no address on invoice)</span></span>
              </label>}
              {!o.isPickup&&<>
              <div className="border-t pt-4">
                <p className="text-sm font-semibold text-gray-700 mb-3">Billing Address</p>
                <div className="flex flex-col gap-3">
                  <F label="Name on Invoice" value={o.billingName||""} onChange={v=>upd("billingName",v)} disabled={detailsLocked}/>
                  <StateSelect value={o.billingStateCode||""} onChange={v=>{ upd("billingStateCode",v); if(o.type==="B2B") upd("placeOfSupply",stateByCode(v)); }} disabled={detailsLocked}/>
                  <F label="Billing Address" value={o.billingAddress||""} onChange={v=>upd("billingAddress",v)} disabled={detailsLocked} rows={2}/>
                </div>
              </div>
              <div className="border-t pt-4">
                <p className="text-sm font-semibold text-gray-700 mb-3">Shipping Address</p>
                <div className="flex flex-col gap-3">
                  <F label="Name" value={o.shippingName||""} onChange={v=>upd("shippingName",v)} disabled={detailsLocked}/>
                  <F label="Contact Number" value={o.shippingContact||""} onChange={v=>upd("shippingContact",v)} disabled={detailsLocked}/>
                  {o.type==="B2B"&&<F label="GSTIN (if different)" value={o.shippingGstin||""} onChange={v=>upd("shippingGstin",v)} disabled={detailsLocked}/>}
                  <StateSelect value={o.shippingStateCode||""} onChange={v=>{ upd("shippingStateCode",v); if(o.type==="B2C") upd("placeOfSupply",stateByCode(v)); }} disabled={detailsLocked}/>
                  <F label="Shipping Address" value={o.shippingAddress||""} onChange={v=>upd("shippingAddress",v)} disabled={detailsLocked} rows={2}/>
                </div>
              </div>
              </>}
              {o.needsGst&&<div className="flex flex-col gap-1 w-64"><label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Place of Supply</label><div className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600">{o.placeOfSupply||<span className="text-gray-400 italic">Auto-filled</span>}</div></div>}
              <F label="Comments / Notes" value={o.comments||""} onChange={v=>upd("comments",v)} rows={2} disabled={detailsLocked}/>
              <div className="border border-dashed border-indigo-200 rounded-xl p-3 bg-indigo-50/40 space-y-2">
                <label className={"flex items-center gap-2 select-none "+(detailsLocked?"opacity-60 cursor-not-allowed":"cursor-pointer")}>
                  <input type="checkbox" checked={!!(o.isReferred)} onChange={e=>!detailsLocked&&upd("isReferred",e.target.checked?1:0)} disabled={detailsLocked} className="rounded"/>
                  <span className="text-xs font-semibold text-indigo-700">🤝 Referred Order?</span>
                </label>
                {!!(o.isReferred)&&<div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <F label="Referred by" value={o.referralPerson||""} onChange={v=>upd("referralPerson",v)} disabled={detailsLocked} placeholder="Person / company name"/>
                    <F label="Referral Amount (₹)" value={o.referralAmount||""} onChange={v=>upd("referralAmount",v)} disabled={detailsLocked} placeholder="0"/>
                  </div>
                  <div className="border-t border-indigo-100 pt-2 space-y-1.5">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Referral Payout</p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <label className="flex items-center gap-1.5 cursor-pointer select-none">
                        <input type="checkbox" checked={!!(o.referralPaid)} onChange={e=>{if(detailsLocked)return; const paid=e.target.checked?1:0; upd("referralPaid",paid); onReferralPaidChange({...o,referralPaid:paid},paid);}} disabled={detailsLocked} className="rounded"/>
                        <span className="text-xs text-gray-600 font-medium">Paid out</span>
                      </label>
                      {!!(o.referralPaid)&&<>
                        <input type="date" value={o.referralPaidDate||""} onChange={e=>upd("referralPaidDate",e.target.value)} disabled={detailsLocked} className={"border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400"+(detailsLocked?" bg-gray-100 text-gray-400 cursor-not-allowed":"")}/>
                        <input type="text" value={o.referralPaidRef||""} onChange={e=>upd("referralPaidRef",e.target.value)} disabled={detailsLocked} placeholder="Txn ref (optional)" className={"border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 flex-1 min-w-0"+(detailsLocked?" bg-gray-100 text-gray-400 cursor-not-allowed":"")}/>
                      </>}
                    </div>
                    {!!(o.isReferred)&&!!( o.referralAmount)&&<p className="text-[10px] text-indigo-600 font-semibold">Due: ₹{Number(o.referralAmount||0).toLocaleString("en-IN")}</p>}
                  </div>
                </div>}
              </div>
              {/* Other Charges — saved on order, carried into Tax Invoice */}
              <div className="border-t pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-700">Other Charges <span className="text-xs font-normal text-gray-400">(shipping, handling — included in Tax Invoice)</span></p>
                  {!detailsLocked&&<button onClick={addCharge} className="text-xs text-indigo-600 border border-indigo-200 hover:bg-indigo-50 px-3 py-1 rounded-lg font-semibold">+ Add</button>}
                </div>
                {charges.map((c,i)=>(
                  <div key={i} className="flex items-center gap-2">
                    <input value={c.label} onChange={e=>!detailsLocked&&updCharge(i,"label",e.target.value)} disabled={detailsLocked} placeholder="Label (e.g. Shipping)"
                      className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                    <span className="text-gray-400 text-sm shrink-0">₹</span>
                    <input type="number" value={c.amount} onChange={e=>updCharge(i,"amount",e.target.value)} onWheel={e=>e.target.blur()}
                      placeholder="0" className="w-24 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
                  {!detailsLocked&&<button onClick={()=>delCharge(i)} className="text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>}
                  </div>
                ))}
                {charges.length>0&&<p className="text-xs text-gray-400 text-right">Total: ₹{fmt(charges.reduce((s,c)=>s+Number(c.amount||0),0))}</p>}
              </div>

              <div className="border-t pt-4">
                <ExpandableItemTable items={orderItems} setItems={setOrderItems} needsGst={effectiveNeedsGst} isIgst={isIgst} readOnly={detailsLocked} products={products} seller={seller} inventory={inventory} orders={orders} wastageLog={wastageLog} currentOrderNo={order.orderNo} label="Order Items" sublabel={hasTaxInv&&!o.needsGst?"GST applied via Tax Invoice":"Edit items here to update quotation"}
                  onSpoolAdded={(entry)=>{ if(filamentLocked)return; const updated=[...filamentUsage,entry]; setFilamentUsage(updated); handleSaveOrder(updated); toast("Spool added"); }}
                  onSpoolQtyChanged={(spoolId, newQty, weightGPerSpool, batchKey, spoolIds)=>{ if(filamentLocked)return;
                    const perSpool = Number(weightGPerSpool||0) || Number(inventory.find(s=>s.id===spoolId)?.weightG||0);
                    const allSpoolIds = spoolIds || [spoolId];
                    // Current entries for this batch
                    const existing = filamentUsage.filter(u=>u.batchKey===batchKey && u.notes?.includes("Sold as whole spool"));
                    const others   = filamentUsage.filter(u=>!(u.batchKey===batchKey && u.notes?.includes("Sold as whole spool")));
                    const qty = Math.max(0, Math.round(Number(newQty)||0));
                    // Build new entries — one per spool, up to qty
                    const newEntries = [];
                    for (let i=0; i<qty; i++) {
                      const sid = allSpoolIds[i] || allSpoolIds[allSpoolIds.length-1];
                      newEntries.push({
                        id: existing[i]?.id || ("FU-"+Date.now()+"-"+sid+"-"+i),
                        inventoryId: sid,
                        weightUsedG: perSpool,
                        isWaste: false,
                        notes: "Sold as whole spool",
                        groupKey: existing[0]?.groupKey || `${inventory.find(s=>s.id===spoolId)?.brand||""}||${inventory.find(s=>s.id===spoolId)?.material||""}||${inventory.find(s=>s.id===spoolId)?.color||""}`,
                        batchKey,
                      });
                    }
                    const updated = [...others, ...newEntries];
                    setFilamentUsage(updated);
                    handleSaveOrder(updated);
                  }}
                  onSpoolRemoved={(spoolId, batchKey)=>{
                    // Remove all entries for this batch (all spools in this order-item row)
                    const updated = batchKey
                      ? filamentUsage.filter(u=>!(u.batchKey===batchKey && u.notes?.includes("Sold as whole spool")))
                      : filamentUsage.filter(u=>u.inventoryId!==spoolId||!u.notes?.includes("Sold as whole spool"));
                    setFilamentUsage(updated);
                    handleSaveOrder(updated);
                  }}/>
              </div>
              <div className="pt-3 border-t space-y-3">
                {detailsLocked&&hasTaxInv&&<p className="text-xs text-amber-600 font-medium text-center">🔒 Delete the Tax Invoice to edit order fields</p>}
                {detailsLocked&&!hasTaxInv&&!canSubTabWrite("details")&&<p className="text-xs text-amber-600 font-medium text-center">🔒 Read-only access — contact admin to edit this order</p>}
                <button
                  onClick={()=>handleSaveOrder()}
                  disabled={saveLocked}
                  className={"relative w-full py-3 rounded-xl font-bold text-sm tracking-wide text-white shadow-sm transition-all duration-200 "+(saveLocked?"bg-gray-300 cursor-not-allowed opacity-60":"bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 hover:shadow-md hover:scale-[1.01]")}
                >
                  Save Changes
                </button>
                <button
                  onClick={()=>{
                    if(window.confirm(`Delete order ${order.orderNo} for ${order.customerName}?\n\nThis will permanently delete the order and all its quotations, invoices and payments. This cannot be undone.`))
                      onDeleteOrder(order.orderNo);
                  }}
                  disabled={detailsLocked}
                  className={`w-full py-3 rounded-xl font-bold text-sm tracking-wide border-2 transition-all duration-200 flex items-center justify-center gap-2 ${detailsLocked?"border-gray-200 text-gray-300 cursor-not-allowed":"border-red-200 text-red-500 hover:bg-red-50 hover:border-red-400"}`}>
                  <span>🗑</span> Delete This Order
                </button>
              </div>
            </>
          )}

          {tab==="quotation" && canSubTabRead("quotation") && (
            <div className="space-y-4">
              {qt
                ? <>
                    <div className="flex flex-col gap-2">
                      <div className="flex items-start justify-between gap-2">
                        <div><p className="font-mono font-bold text-sky-700 break-all">{qt.invNo}</p><p className="text-xs text-gray-400 mt-0.5">{qt.invDate} · <span className="font-semibold text-sky-700">₹{fmt(qt.amount)}</span></p></div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={()=>printOrOpen(buildQuotationHtml(o,qt,seller))} className="flex-1 text-xs border border-sky-200 text-sky-700 hover:bg-sky-50 py-2 rounded-lg font-medium text-center">👁 View</button>
                        <button onClick={()=>downloadHtml(buildQuotationHtml(o,qt,seller),qt.invNo)} className="flex-1 text-xs border border-sky-200 text-sky-700 hover:bg-sky-50 py-2 rounded-lg font-medium text-center">⬇ Download</button>
                      </div>
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

          {tab==="invoices" && canSubTabRead("invoices") && !creating && (
            <div className="space-y-4">
              <div className="flex gap-2 justify-end items-center flex-wrap">
                {order.type==="B2B"&&!invLocked&&pfs.length===0&&<button onClick={()=>handleCreate("proforma")} className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold">+ Proforma Invoice</button>}
                {!invLocked&&((order.type==="B2B"||order.needsGst)
                  ? <button onClick={()=>handleCreate("tax")} className="text-xs bg-slate-700 hover:bg-slate-800 text-white px-4 py-2 rounded-lg font-semibold">+ Tax Invoice</button>
                  : <button onClick={()=>handleCreate("tax")} className="text-xs bg-slate-700 hover:bg-slate-800 text-white px-4 py-2 rounded-lg font-semibold">+ Tax Invoice (will enable GST)</button>
                )}
              </div>
              {pfs.length===0&&tis.length===0&&<p className="text-gray-400 text-sm text-center py-6">No invoices yet. Create one above.</p>}
              {pfs.length>0&&(
                <div>
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Proforma Invoices</p>
                  <div className="space-y-2">
                    {pfs.map(p=>{
                      const tN=p.items.reduce((s,i)=>s+num(i.netAmt),0);
                      return (
                        <div key={p.invNo} className="flex flex-col gap-2 border border-blue-100 bg-blue-50 rounded-xl px-4 py-3">
                          <div className="flex items-start justify-between gap-2">
                            <div><p className="font-mono font-bold text-blue-800 text-sm break-all">{p.invNo}</p><p className="text-xs text-blue-500 mt-0.5">{p.invDate} · <span className="font-semibold text-blue-700">₹{fmt(tN)}</span></p></div>
                            {canDeleteInv&&<button onClick={()=>onDeleteInvoice(p.invNo,"proforma")} className="text-xs border border-red-200 text-red-500 hover:bg-red-50 px-2.5 py-1 rounded-lg font-medium shrink-0">Delete</button>}
                          </div>
                          <div className="flex gap-2">
                            <button onClick={()=>printOrOpen(buildInvoiceHtml(o,p,"proforma",seller))} className="flex-1 text-xs border border-blue-200 text-blue-600 hover:bg-blue-100 py-2 rounded-lg font-medium text-center">👁 View</button>
                            <button onClick={()=>downloadHtml(buildInvoiceHtml(o,p,"proforma",seller),p.invNo)} className="flex-1 text-xs border border-blue-200 text-blue-600 hover:bg-blue-100 py-2 rounded-lg font-medium text-center">⬇ Download</button>
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
                      const tN=t.items.reduce((s,i)=>s+num(i.netAmt),0)+(t.charges||[]).reduce((s,c)=>s+num(c.amount),0);
                      return (
                        <div key={t.invNo} className="flex flex-col gap-2 border border-slate-200 bg-slate-50 rounded-xl px-4 py-3">
                          <div className="flex items-start justify-between gap-2">
                            <div><p className="font-mono font-bold text-slate-800 text-sm break-all">{t.invNo}</p><p className="text-xs text-slate-500 mt-0.5">{t.invDate} · <span className="font-semibold text-slate-700">₹{fmt(tN)}</span></p></div>
                            {canDeleteInv&&<button onClick={()=>onDeleteInvoice(t.invNo,"tax")} className="text-xs border border-red-200 text-red-500 hover:bg-red-50 px-2.5 py-1 rounded-lg font-medium shrink-0">Delete</button>}
                          </div>
                          <div className="flex gap-2">
                            <button onClick={()=>printOrOpen(buildInvoiceHtml(o,t,"tax",seller))} className="flex-1 text-xs border border-slate-200 text-slate-600 hover:bg-slate-100 py-2 rounded-lg font-medium text-center">👁 View</button>
                            <button onClick={()=>downloadHtml(buildInvoiceHtml(o,t,"tax",seller),t.invNo)} className="flex-1 text-xs border border-slate-200 text-slate-600 hover:bg-slate-100 py-2 rounded-lg font-medium text-center">⬇ Download</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab==="invoices" && canSubTabRead("invoices") && creating && (
<div className="space-y-4">
              <InvoiceEditor
              inv={{ invNo:"(auto)", invDate:today(), items: order.items && order.items.length > 0 ? order.items.map(i=>calcItem({...i}, creating==="tax" ? true : order.needsGst)) : [{...EMPTY_ITEM}], notes:"", charges: creating==="tax" ? (order.charges||[]).map(c=>({...c})) : [] }}
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



          {tab==="filament" && canSubTabRead("filament") && (
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
              readOnly={filamentLocked}
            />
          )}

          {tab==="payments" && canSubTabRead("payments") && (() => {
            const tiTotal=tis.reduce((s,t)=>s+(t.amount||(t.items?.reduce((a,i)=>a+num(i.netAmt),0)||0)+(t.charges||[]).reduce((a,c)=>a+num(c.amount),0)),0);
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
                {!payLocked&&<div className="border border-indigo-100 bg-indigo-50/40 rounded-xl p-4 space-y-3">
                  <p className="text-xs font-bold text-indigo-700 uppercase tracking-wide">Record Payment</p>
                  <div className="flex flex-col gap-3">
                    <F label="Date" type="date" value={newPay.date} onChange={v=>setNewPay(p=>({...p,date:v}))}/>
                    <F label="Amount (₹)" type="number" value={newPay.amount} onChange={v=>setNewPay(p=>({...p,amount:v}))} placeholder="0.00"/>
                    <S label="Payment Mode" value={newPay.mode} onChange={v=>setNewPay(p=>({...p,mode:v}))} options={PAYMENT_MODES}/>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Received By{num(o.advance)>0&&<span className="text-red-400"> *</span>}</label>
                      <select value={newPay.receivedBy} onChange={e=>setNewPay(p=>({...p,receivedBy:e.target.value}))} className="border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                        <option value="">— Select recipient —</option>
                        <option value="__company__">{seller?.name||"Company"}</option>{recipients.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </div>
                    <F label="Txn / Ref No (optional)" value={newPay.txnRef} onChange={v=>setNewPay(p=>({...p,txnRef:v}))} placeholder="UPI ref, cheque no…"/>
                    <F label="Comments (optional)" value={newPay.comments} onChange={v=>setNewPay(p=>({...p,comments:v}))} placeholder="e.g. Part payment"/>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={!!newPay.isRefund} onChange={e=>setNewPay(p=>({...p,isRefund:e.target.checked,refundTo:e.target.checked?(o.customerName||""):""}))} className="w-4 h-4 rounded accent-red-500"/>
                    <span className="text-sm text-gray-600 font-semibold">This is a refund <span className="font-normal text-gray-400 text-xs">(outgoing — deducted from income)</span></span>
                  </label>
                  {newPay.isRefund&&<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <F label="Refund To (Customer)" value={newPay.refundTo} onChange={v=>setNewPay(p=>({...p,refundTo:v}))} placeholder="Customer name / contact" className="col-span-2"/>
                  </div>}

                  <button onClick={handleAddPayment} className={`w-full py-3 rounded-xl text-sm font-bold text-white transition-all ${newPay.isRefund?"bg-red-600 hover:bg-red-700":"bg-indigo-600 hover:bg-indigo-700"}`}>
                    {newPay.isRefund?"+ Record Refund":"+ Add Payment"}
                  </button>
                </div>}

                {/* Payment history */}
                {num(o.advance)>0&&(()=>{
                  const advRcp=o.advanceRecipient==="__company__"?{name:seller?.name||"Company"}:(recipients.find(r=>r.id===o.advanceRecipient)||allRecipients.find(r=>r.id===o.advanceRecipient));
                  return (
                    <div className="border border-gray-200 rounded-xl px-4 py-3 bg-white">
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
                    <div key={p.id} className={`flex items-start justify-between rounded-xl px-4 py-3 gap-3 border ${p.isRefund?"border-red-100 bg-red-50/40":"border-gray-100 bg-white"}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-sm font-bold ${p.isRefund?"text-red-600":"text-emerald-600"}`}>{p.isRefund?"−":""}₹{fmt(p.amount)}</span>
                          {p.isRefund&&<span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-semibold">Refund</span>}
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{p.mode}</span>
                          <span className="text-xs text-gray-400">{p.date}</span>
                        </div>
                        {p.isRefund&&p.refundTo&&<p className="text-xs text-red-500 mt-0.5">↩ Refunded to: {p.refundTo}</p>}
                        {p.receivedBy&&(()=>{const r=p.receivedBy==="__company__"?{name:seller?.name||"Company"}:(recipients.find(x=>x.id===p.receivedBy)||allRecipients.find(x=>x.id===p.receivedBy));return r?<p className="text-xs text-indigo-500 mt-0.5">👤 {r.name}</p>:null;})()}
                        {p.txnRef&&<p className="text-xs text-gray-400 mt-0.5 font-mono">Ref: {p.txnRef}</p>}
                        {p.comments&&<p className="text-xs text-gray-500 mt-0.5">{p.comments}</p>}
                      </div>
                      {!payLocked&&<button onClick={()=>handleDeletePayment(p.id)} className="text-red-300 hover:text-red-500 text-lg leading-none shrink-0 mt-0.5">×</button>}
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
function ExpandableItemTable({ items, setItems, needsGst, label, sublabel, isIgst=false, products=[], seller={}, inventory=[], orders=[], wastageLog=[], currentOrderNo="", onSpoolAdded=null, onSpoolRemoved=null, onSpoolQtyChanged=null, readOnly=false }) {
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
        <ItemTable items={items} setItems={setItems} needsGst={needsGst} isIgst={isIgst} products={products} seller={seller} inventory={inventory} orders={orders} wastageLog={wastageLog} currentOrderNo={currentOrderNo} onSpoolAdded={onSpoolAdded} onSpoolRemoved={onSpoolRemoved} onSpoolQtyChanged={onSpoolQtyChanged} readOnly={readOnly}/>
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
            <ItemTable items={fsItems} setItems={setFsItems} needsGst={needsGst} isIgst={isIgst} products={products} seller={seller} inventory={inventory} orders={orders} wastageLog={wastageLog} currentOrderNo={currentOrderNo} onSpoolAdded={onSpoolAdded} onSpoolRemoved={onSpoolRemoved} onSpoolQtyChanged={onSpoolQtyChanged} readOnly={readOnly}/>
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

function OrdersList({ orders, setOrders, quotations, setQuotations, proformas, setProformas, taxInvoices, setTaxInvoices, seller, series, recipients=[], allRecipients=[], upsertPayment=()=>{}, enqueue=()=>{}, initialOrder=null, onClearInitialOrder=()=>{}, toast=()=>{}, inventory=[], wastageLog=[], setWastageLog=()=>{}, products=[], expenses=[], setExpenses=()=>{}, readOnly=false, subTabPerms=null }) {
  // canSubTab: null means all tabs accessible; object means check per sub-tab
  const canSubTabRead = (st) => !subTabPerms || (subTabPerms[st]==="read"||subTabPerms[st]==="write");
  const canSubTabWrite = (st) => !subTabPerms || subTabPerms[st]==="write";
  const [search,setSearch]=useState("");
  const [filter,setFilter]=useState("All");
  const [typeFilter,setTypeFilter]=useState("All");
  const [balFilter,setBalFilter]=useState(false);
  const [channelFilter,setChannelFilter]=useState("All");
  const [openOrder,setOpenOrder]=useState(null);
  useEffect(()=>{ if(initialOrder){ setOpenOrder(initialOrder); onClearInitialOrder(); } },[initialOrder]);

  const getTotal = (o) => {
    const tiTotal=taxInvoices.filter(t=>t.orderId===o.orderNo).reduce((s,t)=>s+(t.amount||(t.items?.reduce((a,i)=>a+num(i.netAmt),0)||0)+(t.charges||[]).reduce((a,c)=>a+num(c.amount),0)),0);
    const qt=quotations.find(q=>q.orderId===o.orderNo);
    const qtTotal=(qt?num(qt.amount):(o.items||[]).reduce((s,i)=>s+num(i.netAmt),0))+(o.charges||[]).reduce((s,c)=>s+num(c.amount),0);
    return tiTotal>0?tiTotal:qtTotal;
  };
  const getTotalPaid = (o) => num(o.advance) + (o.payments||[]).reduce((s,p)=>s+(p.isRefund?-num(p.amount):num(p.amount)),0);

  const searched=orders.filter(o=>o.orderNo.toLowerCase().includes(search.toLowerCase())||o.customerName.toLowerCase().includes(search.toLowerCase()));
  const filtered=searched
    .filter(o=>filter==="All"||o.status===filter)
    .filter(o=>typeFilter==="All"||o.type===typeFilter)
    .filter(o=>!balFilter||(getTotal(o)-getTotalPaid(o))>0)
    .filter(o=>channelFilter==="All"||(channelFilter==="Offline"?(o.channel||"Offline")==="Offline":(o.channel||"Offline")!=="Offline"&&(channelFilter==="Online"||o.channel===channelFilter)));

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
    // Sync all payments to Supabase — upsert current, delete removed
    const prevOrder = orders.find(o=>o.orderNo===orderNo);
    const prevPayIds = new Set((prevOrder?.payments||[]).map(p=>String(p.id)));
    const newPayIds = new Set((updated.payments||[]).map(p=>String(p.id)));
    prevPayIds.forEach(id=>{ if(!newPayIds.has(id)) enqueue({action:"delete",table:"payments",col:"id",val:id}); });
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
    const tiTotal=tis.reduce((s,t)=>s+(t.amount||(t.items?.reduce((a,i)=>a+num(i.netAmt),0)||0)+(t.charges||[]).reduce((a,c)=>a+num(c.amount),0)),0);
    // Order card: always items + charges
    const chargesTotal=(o.charges||[]).reduce((s,c)=>s+num(c.amount),0);
    const qtTotal=(qt?num(qt.amount):(o.items||[]).reduce((s,i)=>s+num(i.netAmt),0))+chargesTotal;
    const tN=tiTotal>0?tiTotal:qtTotal;
    const bal=o.status==="Cancelled"?0:tN-getTotalPaid(o);
    const due=o.dueDate||"";
    const isOverdue=o.status==="Pending"&&due&&due<todayStr;
    const isDueSoon=o.status==="Pending"&&due&&due>=todayStr&&due<=addDays(todayStr,3);
    return (
      <div key={o.orderNo} onClick={()=>setOpenOrder(o)} className={`border rounded-lg px-3 py-2.5 hover:shadow-sm transition-all bg-white cursor-pointer ${isOverdue?"border-red-200 bg-red-50/30":isDueSoon?"border-amber-200 bg-amber-50/30":"border-gray-100 hover:border-indigo-200"}`}>
        {/* Row 1: order no + badges + arrow */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <span className="font-bold text-slate-700 font-mono text-xs">{o.orderNo}</span>
            <Badge label={o.type}/>{o.type==="B2C"&&!o.needsGst&&!(taxInvoices.some(t=>t.orderId===o.orderNo))&&<Badge label="No GST"/>}<Badge label={o.status}/>
            {isOverdue&&<span className="text-xs font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded-full">⚠ Overdue</span>}
            {isDueSoon&&!isOverdue&&<span className="text-xs font-bold text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded-full">⏰ Due soon</span>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">{(()=>{const cb=channelBadge(o.channel);return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cb.cls}`}>{cb.icon} {cb.label}</span>})()}<span className="text-gray-300">›</span></div>
        </div>
        {/* Row 2: customer + GSTIN */}
        <p className="text-sm font-bold text-gray-800 mt-1 leading-tight">{o.customerName}</p>
        {o.type==="B2B"&&o.gstin&&<p className="text-xs text-gray-400 font-mono">{o.gstin}</p>}
        {/* Row 3: data pills */}
        <div className="grid grid-cols-5 gap-0 mt-1.5 border border-gray-100 rounded-md overflow-hidden">
          {[
            ["Date", o.orderDate||"—", "text-gray-600"],
            ["Due", due||"—", isOverdue?"text-red-600":isDueSoon?"text-amber-600":"text-gray-600"],
            ["Total", tN>0?`₹${fmt(tN)}`:"—", "text-gray-800"],
            ["Advance", num(o.advance)>0?`₹${fmt(o.advance)}`:"—", "text-emerald-600"],
            ["Balance", tN>0?(bal>0?`₹${fmt(bal)}`:"Nil"):"—", bal>0?"text-orange-500":"text-gray-400"],
          ].map(([lbl,val,cls],i)=>(
            <div key={i} className={`py-1.5 flex flex-col items-center justify-center ${i<4?"border-r border-gray-100":""}`}>
              <p className="leading-none mb-1 text-center text-gray-500 font-semibold uppercase tracking-wide" style={{fontSize:"9px"}}>{lbl}</p>
              <p className={`text-xs font-semibold text-center ${cls}`}>{val}</p>
            </div>
          ))}
        </div>
        {/* Row 4: print buttons */}
        <div className="flex gap-1 flex-wrap mt-1.5 pt-1.5 border-t border-gray-100" onClick={e=>e.stopPropagation()}>
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
        <div className="space-y-2">
          <div className="flex gap-2 items-center overflow-x-auto scrollbar-none pb-0.5">
            <span className="text-[10px] font-bold text-gray-400 uppercase shrink-0">Status</span>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1 shrink-0">
              {["All","Pending","Completed","Cancelled"].map(f=>(
                <button key={f} onClick={()=>setFilter(f)} className={`px-2.5 py-1 rounded-md text-[11px] font-semibold whitespace-nowrap transition-all ${filter===f?"bg-white text-indigo-700 shadow-sm":"text-gray-500"}`}>{f}</button>
              ))}
            </div>
            <span className="text-[10px] font-bold text-gray-400 uppercase shrink-0 ml-1">Type</span>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1 shrink-0">
              {["All","B2B","B2C"].map(t=>(
                <button key={t} onClick={()=>setTypeFilter(t)} className={`px-2.5 py-1 rounded-md text-[11px] font-semibold whitespace-nowrap transition-all ${typeFilter===t?"bg-white text-indigo-700 shadow-sm":"text-gray-500"}`}>{t}</button>
              ))}
            </div>
            <button onClick={()=>setBalFilter(v=>!v)} className={`shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold whitespace-nowrap border transition-all ${balFilter?"bg-orange-500 border-orange-500 text-white":"border-gray-200 text-gray-500"}`}>⚖️ Balance</button>
          </div>
          <div className="flex gap-1 items-center overflow-x-auto scrollbar-none pb-0.5">
            <span className="text-[10px] font-bold text-gray-400 uppercase shrink-0">Channel</span>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
              {["All","Offline","Online",...ONLINE_PLATFORMS].map(f=>(
                <button key={f} onClick={()=>setChannelFilter(f)} className={`px-2.5 py-1 rounded-md text-[11px] font-semibold whitespace-nowrap transition-all ${channelFilter===f?"bg-white text-indigo-700 shadow-sm":"text-gray-500"}`}>{f}</button>
              ))}
            </div>
          </div>
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
          canSubTabRead={canSubTabRead}
          canSubTabWrite={canSubTabWrite}
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
          allRecipients={allRecipients}
          products={products}
          enqueue={enqueue}
          onReferralPaidChange={(ord, paid)=>{
            const expId = `referral_${ord.orderNo}`;
            const baseExp = { id:expId, date:new Date().toISOString().slice(0,10), paidBy:"__company__", amount:Number(ord.referralAmount)||0, category:"Referral", comment:`Referral payout to ${ord.referralPerson||"?"} for order ${ord.orderNo}` };
            if (paid) {
              const newExp = {...baseExp, isDeleted:false};
              setExpenses(prev => { const ex=prev.find(e=>e.id===expId); return ex?prev.map(e=>e.id===expId?{...e,...newExp}:e):[...prev,newExp]; });
              enqueue({action:"upsert", table:"expenses", row:{ id:expId, date:baseExp.date, paid_by:"__company__", amount:baseExp.amount, category:"Referral", comment:baseExp.comment, is_deleted:false }});
            } else {
              setExpenses(prev => prev.map(e=>e.id===expId?{...e,isDeleted:true}:e));
              enqueue({action:"upsert", table:"expenses", row:{ id:expId, date:baseExp.date, paid_by:"__company__", amount:baseExp.amount, category:"Referral", comment:baseExp.comment, is_deleted:true }});
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────
// ─── Product Manager ──────────────────────────────────────────────────────────
function ProductManager({ products=[], setProducts=()=>{}, seller={}, toast=()=>{}, inventory=[], readOnly=false }) {
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
          {!readOnly&&<button onClick={handleSave} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">{editId?"Update":"Add Product"}</button>}
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
            <div key={p.id} className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between gap-4 hover:shadow-sm transition-all">
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
                {!readOnly&&<button onClick={()=>handleEdit(p)} className="text-xs text-indigo-600 border border-indigo-200 hover:bg-indigo-50 px-3 py-1.5 rounded-lg">Edit</button>}
                {!readOnly&&<button onClick={()=>handleDelete(p.id)} className="text-xs text-red-400 border border-red-100 hover:bg-red-50 px-2.5 py-1.5 rounded-lg">×</button>}
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
  const qtPrev = [sr.qtPrefix,qtPeriod2].filter(Boolean).join("")+String(1).padStart(Number(sr.qtDigits)||6,"0");
  const pfPrev = [sr.pfPrefix,pfPeriod].filter(Boolean).join("")+String(1).padStart(Number(sr.invDigits)||6,"0");
  const tiPrev = [sr.tiPrefix,tiPeriod].filter(Boolean).join("")+String(1).padStart(Number(sr.invDigits)||6,"0");

  const formatOpts = [{value:"NONE",label:"None (no date)"},{value:"YYYY",label:"YYYY – e.g. 2025"},{value:"YYYYMM",label:"YYYYMM – e.g. 202501"},{value:"YYYYMMDD",label:"YYYYMMDD – e.g. 20250107"}];
  const digitOpts = ["3","4","5","6"].map(d=>({value:d,label:`${d} digits`}));

  return (
    <div className="space-y-8 max-w-2xl">
      {/* Business */}
      <section>
        <h3 className="font-bold text-gray-800 mb-4">Business Details</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <F label="Company Name" value={s.name} onChange={v=>setS({...s,name:v})} className="md:col-span-2"/>
          <F label="GSTIN" value={s.gstin} onChange={v=>setS({...s,gstin:v})}/>
          <F label="State" value={s.state} onChange={v=>setS({...s,state:v})}/>
          <StateSelect label="State/UT Code" value={extractStateCode(s.stateCode)||s.stateCode} onChange={v=>setS({...s,stateCode:v,state:stateByCode(v)})}/>
          <F label="Address" value={s.address} onChange={v=>setS({...s,address:v})} rows={2} className="md:col-span-2"/>
          <F label="Phone" value={s.phone} onChange={v=>setS({...s,phone:v})}/>
          <F label="Email" value={s.email} onChange={v=>setS({...s,email:v})}/>
          <F label="Bank Name" value={s.bank} onChange={v=>setS({...s,bank:v})}/>
          <F label="Account Number" value={s.accountNo} onChange={v=>setS({...s,accountNo:v})}/>
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
          <F label="Quotation — Terms & Conditions" value={s.qtTerms||""} onChange={v=>setS({...s,qtTerms:v})} rows={4} placeholder="Enter terms for quotations…"/>
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
            <div key={r.id} className="border border-gray-200 rounded-xl px-4 py-3 bg-white flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-slate-800">{r.name}</span>
              </div>
              <div className="flex gap-1.5 shrink-0 flex-wrap">
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
function ClientMaster({ clients, setClients, deleteClient=()=>{}, toast=()=>{}, readOnly=false }) {
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
          {!readOnly&&<button onClick={handleNew} className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-semibold">+ Add Client</button>}
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <F label={clientTab==="B2C"?"Customer Name":"Company Name"} value={form.name} onChange={v=>upd("name",v)} required/>
              {clientTab==="B2B"&&<F label="GSTIN" value={form.gstin} onChange={v=>upd("gstin",v)} disabled={readOnly} placeholder="29XXXXX0000X1ZX"/>}
              <F label="Phone" value={form.contact} onChange={v=>upd("contact",v)} placeholder="+91 XXXXX XXXXX"/>
              <F label="Email" value={form.email||""} onChange={v=>upd("email",v)} disabled={readOnly} placeholder="client@email.com"/>
              <div className="flex flex-col gap-1"><label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Place of Supply</label><div className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600">{form.placeOfSupply||<span className="text-gray-400 italic">Auto-filled</span>}</div></div>
            </div>
          </div>

          <div className="border-t pt-4">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Billing Address</p>
            <div className="flex flex-col gap-3">
              <F label="Name on Invoice" value={form.billingName} onChange={v=>upd("billingName",v)} disabled={readOnly} placeholder="Company name or individual"/>
              <StateSelect value={form.billingStateCode} onChange={v=>{ if(readOnly)return; upd("billingStateCode",v); upd("placeOfSupply",stateByCode(v)); }} disabled={readOnly}/>
              <F label="Billing Address" value={form.billingAddress} onChange={v=>upd("billingAddress",v)} disabled={readOnly} rows={2} className="col-span-2"/>
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <F label="Name" value={sameAsBilling ? (form.billingName||form.name) : form.shippingName} onChange={v=>{if(!sameAsBilling)upd("shippingName",v);}} disabled={sameAsBilling}/>
              <F label="Contact Number" value={sameAsBilling ? form.contact : form.shippingContact} onChange={v=>{if(!sameAsBilling)upd("shippingContact",v);}} disabled={sameAsBilling} placeholder="+91 XXXXX XXXXX"/>
              <F label="GSTIN (if different)" value={sameAsBilling ? form.gstin : form.shippingGstin} onChange={v=>{if(!sameAsBilling)upd("shippingGstin",v);}} disabled={sameAsBilling}/>
              <StateSelect value={sameAsBilling ? form.billingStateCode : form.shippingStateCode} onChange={v=>{ if(!sameAsBilling&&!readOnly){ upd("shippingStateCode",v); upd("placeOfSupply",stateByCode(v)); } }} disabled={sameAsBilling||readOnly}/>
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
          <div key={c.id} className="bg-white border border-gray-200 rounded-xl p-4 hover:shadow-md transition-all">
            <div className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-800">{c.name}</span>
                    <span className="text-xs font-mono bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full shrink-0">{c.id}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                    {c.gstin && <div>GSTIN: <span className="font-mono">{c.gstin}</span></div>}
                    {c.contact && <div>📞 {c.contact}</div>}
                    {c.email && <div>✉ {c.email}</div>}
                    {c.billingAddress && <div className="text-gray-400 break-words">{c.billingAddress}</div>}
                  </div>
                </div>
                {!readOnly&&<div className="flex gap-1.5 shrink-0">
                  <button onClick={()=>handleEdit(c)} className="text-xs border border-indigo-200 text-indigo-600 hover:bg-indigo-50 px-3 py-1.5 rounded-lg font-medium">Edit</button>
                  <button onClick={()=>handleDelete(c.id)} className="text-xs border border-red-200 text-red-500 hover:bg-red-50 px-3 py-1.5 rounded-lg font-medium">Delete</button>
                </div>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Expense Tracker ──────────────────────────────────────────────────────────
const DEFAULT_EXPENSE_CATS = ["Electricity","Groceries","Entertainment","Filament","Resin","Rent","Debt","Travel","Asset Purchase","Salary","Miscellaneous"];
const EMPTY_EXPENSE = { id:"", date:"", paidBy:"", amount:"", category:"Miscellaneous", comment:"" };



function AnalyticsDashboard({ orders=[], expenses=[], inventory=[], wastageLog=[], taxInvoices=[], quotations=[], subTabPerms=null }) {
  const canSection = (id) => !subTabPerms || subTabPerms[id]==="read"||subTabPerms[id]==="write";
  const firstSection = ["overview","trends","orders","finance","filament","customers","referrals"].find(s=>canSection(s)) || "overview";
  const [section, setSection] = useState(firstSection);
  const [period, setPeriod] = useState("month");
  const [year, setYear] = useState(new Date().getFullYear());
  const [refSort, setRefSort] = useState("pending");

  const num = (v) => Number(v||0);
  const fmt = (n) => "₹"+Number(n||0).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmtK = (n) => "₹"+Number(n||0).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const PALETTE = ["#6366f1","#22d3ee","#f59e0b","#10b981","#f43f5e","#8b5cf6","#fb923c","#84cc16","#0ea5e9","#ec4899","#14b8a6","#a855f7"];
  const bc = (i) => PALETTE[i%PALETTE.length];

  const curYear = new Date().getFullYear();
  const activeOrders = orders.filter(o=>o.status!=="Cancelled");
  const years = [...new Set(orders.map(o=>o.orderDate?.slice(0,4)).filter(Boolean))].sort().reverse();
  // Revenue (excl GST) — grossAmt only
  const getVal = (o) => (o.items||[]).reduce((s,i)=>s+num(i.grossAmt),0)+(o.charges||[]).reduce((s,c)=>s+num(c.amount),0);
  // Full invoice value incl GST — used for outstanding
  const getFullVal = (o) => (o.items||[]).reduce((s,i)=>s+num(i.netAmt),0)+(o.charges||[]).reduce((s,c)=>s+num(c.amount),0);
  const getEffVal = (o) => o.status==="Cancelled" ? Math.max(0,getPaid(o)) : getVal(o);
  const getPaid = (o) => num(o.advance)+(o.payments||[]).reduce((s,p)=>s+(p.isRefund?-num(p.amount):num(p.amount)),0);

  // Revenue amount excl GST (for analytics revenue figures)
  // Revenue = grossAmt only (excludes GST + other charges)
  const getInvoicedAmt = (o) => {
    const tis = taxInvoices.filter(t=>t.orderId===o.orderNo);
    const qt = quotations.find(q=>q.orderId===o.orderNo);
    const raw = tis.length
      ? tis.reduce((s,t)=>s+(t.items?.reduce((a,i)=>a+num(i.grossAmt),0)||0),0)
      : (qt
        ? (qt.items?.reduce((a,i)=>a+num(i.grossAmt),0) || num(qt.amount))
        : (o.items||[]).reduce((s,i)=>s+num(i.grossAmt),0));
    return o.status==="Cancelled" ? Math.max(0,getPaid(o)) : raw;
  };
  // Gross order value = netAmt (includes GST) + other charges
  const getGrossOrderAmt = (o) => {
    const tis = taxInvoices.filter(t=>t.orderId===o.orderNo);
    const qt = quotations.find(q=>q.orderId===o.orderNo);
    const raw = tis.length
      ? tis.reduce((s,t)=>s+(t.items?.reduce((a,i)=>a+num(i.netAmt),0)||0)+(t.charges||[]).reduce((s,c)=>s+num(c.amount),0),0)
      : (qt
        ? (qt.items?.reduce((a,i)=>a+num(i.netAmt),0) || num(qt.amount))
        : (o.items||[]).reduce((s,i)=>s+num(i.netAmt),0));
    return o.status==="Cancelled" ? Math.max(0,getPaid(o)) : raw;
  };
  // Full invoice amount incl GST — used for outstanding (what customer actually owes)
  const getFullInvoicedAmt = (o) => {
    const tis = taxInvoices.filter(t=>t.orderId===o.orderNo);
    const qt = quotations.find(q=>q.orderId===o.orderNo);
    const raw = tis.length
      ? tis.reduce((s,t)=>s+(t.items?.reduce((a,i)=>a+num(i.netAmt),0)||0),0)
      : (qt ? num(qt.amount) : (o.items||[]).reduce((s,i)=>s+num(i.netAmt),0));
    return o.status==="Cancelled" ? Math.max(0,getPaid(o)) : raw;
  };
  const getOutstanding = (o) => o.status==="Cancelled" ? 0 : Math.max(0, getFullInvoicedAmt(o) - getPaid(o));

  // Period filter helper
  const inPeriod = (dateStr) => {
    if (!dateStr) return false;
    if (period==="year") return true; // all years shown
    return dateStr.startsWith(String(year));
  };
  const inPeriodExp = (dateStr) => {
    if (!dateStr) return false;
    if (period==="year") return true;
    return dateStr.startsWith(String(year));
  };

  // KPIs — filtered by selected period/year
  const periodOrders = orders.filter(o=>inPeriod(o.orderDate));
  const periodActiveOrders = periodOrders.filter(o=>o.status!=="Cancelled");
  const completedRevOrders = periodOrders.filter(o=>o.status==="Completed");
  const orderValueOrders = periodOrders.filter(o=>o.status==="Completed"||o.status==="Pending");
  const totalRev = completedRevOrders.reduce((s,o)=>s+getInvoicedAmt(o),0);
  const totalOrderValue = orderValueOrders.reduce((s,o)=>s+getInvoicedAmt(o),0); // net excl GST
  const totalOrderValueGross = orderValueOrders.reduce((s,o)=>s+getGrossOrderAmt(o),0); // gross incl GST+charges
  const totalPaid = periodOrders.reduce((s,o)=>s+getPaid(o),0);
  const periodExp = expenses.filter(e=>!e.isDeleted&&inPeriodExp(e.date));
  const totalExp = periodExp.reduce((s,e)=>s+num(e.amount),0);
  const totalOrders = periodActiveOrders.length;
  const completedOrders = periodActiveOrders.filter(o=>o.status==="Completed").length;
  const pendingOrders = periodActiveOrders.filter(o=>o.status==="Pending").length;
  const cancelledOrders = periodOrders.filter(o=>o.status==="Cancelled").length;
  const avgOrder = completedOrders?(completedRevOrders.reduce((s,o)=>s+getInvoicedAmt(o),0)/completedOrders):0;
  const totalOutstanding = periodOrders.reduce((s,o)=>s+getOutstanding(o),0);
  const collectionRate = totalRev>0?Math.round(Math.max(0,totalRev-totalOutstanding)/totalRev*100):0;
  const netProfit = totalPaid - totalExp;
  const profitMargin = totalPaid?Math.round(netProfit/totalPaid*100):0;

  // Filament
  const allUsage = periodOrders.flatMap(o=>o.filamentUsage||[]);
  const totalUsedG = allUsage.filter(u=>!u.isWaste).reduce((s,u)=>s+num(u.weightUsedG),0);
  const totalWasteG = wastageLog.filter(w=>inPeriod(w.date)).reduce((s,w)=>s+num(w.weightG),0);
  const wasteRate = (totalUsedG+totalWasteG)?((totalWasteG/(totalUsedG+totalWasteG))*100).toFixed(1):0;

  // Monthly data builder
  const monthlyData = (yr) => MONTHS.map((m,i)=>{
    const ords = orders.filter(o=>{const d=o.orderDate||"";return d.startsWith(String(yr))&&Number(d.slice(5,7))===i+1;});
    const exps = expenses.filter(e=>!e.isDeleted&&(e.date||"").startsWith(String(yr))&&Number((e.date||"").slice(5,7))===i+1);
    const rev = ords.filter(o=>o.status==="Completed").reduce((s,o)=>s+getInvoicedAmt(o),0);
    const exp = exps.reduce((s,e)=>s+num(e.amount),0);
    return {label:m, month:i+1, rev, exp, profit:rev-exp, orders:ords.length, paid:ords.reduce((s,o)=>s+getPaid(o),0)};
  });

  const thisYearData = monthlyData(year);
  const prevYearData = monthlyData(year-1);

  // Yearly data for period=year mode
  const allYears = years.length ? years : [String(year)];
  const yearlyDataArr = allYears.map(yr=>({
    label:String(yr),
    rev: orders.filter(o=>o.orderDate?.startsWith(String(yr))&&o.status==="Completed").reduce((s,o)=>s+getInvoicedAmt(o),0),
    exp: expenses.filter(e=>!e.isDeleted&&(e.date||"").startsWith(String(yr))).reduce((s,e)=>s+num(e.amount),0),
    orders: orders.filter(o=>o.orderDate?.startsWith(String(yr))&&o.status!=="Cancelled").length,
    paid: orders.filter(o=>o.orderDate?.startsWith(String(yr))).reduce((s,o)=>s+getPaid(o),0),
  }));
  yearlyDataArr.forEach(d=>{d.profit=d.rev-d.exp;});

  // Use period-aware data in charts
  const chartData = period==="year" ? yearlyDataArr : thisYearData;
  const chartLabel = period==="year" ? "All Years" : String(year);

  // Cumulative
  const cumulativeRev = thisYearData.reduce((acc,d,i)=>{acc.push((acc[i-1]||0)+d.rev);return acc;},[]);
  const cumulativeExp = thisYearData.reduce((acc,d,i)=>{acc.push((acc[i-1]||0)+d.exp);return acc;},[]);
  const cumulativeProfit = cumulativeRev.map((r,i)=>r-cumulativeExp[i]);

  // Projection: linear regression on last 3 months with data
  const nonZeroMonths = thisYearData.filter(d=>d.rev>0);
  let projNextMonth = 0;
  if (nonZeroMonths.length>=2) {
    const last3 = nonZeroMonths.slice(-3);
    const avgGrowth = last3.length>1?last3.slice(1).reduce((s,d,i)=>{const prev=last3[i];return s+(prev.rev>0?(d.rev-prev.rev)/prev.rev:0);},0)/(last3.length-1):0;
    projNextMonth = Math.round((last3[last3.length-1].rev)*(1+avgGrowth));
  }

  // YoY
  const prevYearRev = prevYearData.reduce((s,d)=>s+d.rev,0);
  const yoyGrowth = prevYearRev>0?Math.round((thisYearData.reduce((s,d)=>s+d.rev,0)-prevYearRev)/prevYearRev*100):null;

  // Channel
  const channelMap = {};
  activeOrders.forEach(o=>{const c=o.channel||"Offline";channelMap[c]=(channelMap[c]||0)+1;});
  // Also build detailed channel map (already using specific platform names like Amazon, Flipkart etc.)

  // Expenses
  const expByCat = {};
  expenses.filter(e=>!e.isDeleted).forEach(e=>{expByCat[e.category||"Other"]=(expByCat[e.category||"Other"]||0)+num(e.amount);});
  const expCats = Object.entries(expByCat).sort((a,b)=>b[1]-a[1]);

  // Customers
  const custMap = {};
  activeOrders.forEach(o=>{
    if(!custMap[o.customerName])custMap[o.customerName]={name:o.customerName,orders:0,value:0,paid:0,type:o.type,lastDate:""};
    custMap[o.customerName].orders++;
    custMap[o.customerName].value+=getInvoicedAmt(o);
    custMap[o.customerName].paid+=getPaid(o);
    if((o.orderDate||"")>custMap[o.customerName].lastDate)custMap[o.customerName].lastDate=o.orderDate||"";
  });
  const topCustomers = Object.values(custMap).sort((a,b)=>b.value-a.value).slice(0,7);

  // Payment modes
  const modeMap = {};
  activeOrders.forEach(o=>{
    if(num(o.advance)>0)modeMap[o.paymentMode||"?"]=(modeMap[o.paymentMode||"?"]||0)+1;
    (o.payments||[]).filter(p=>!p.isRefund).forEach(p=>{modeMap[p.mode||"?"]=(modeMap[p.mode||"?"]||0)+1;});
  });

  // Filament combined: brand||material||color
  // Filter usage by period
  const curM2=new Date().getMonth()+1, curY2=new Date().getFullYear();
  const filteredUsage = period==="year"
    ? allUsage
    : allUsage.filter(u=>{
        const o=orders.find(ord=>(ord.filamentUsage||[]).some(fu=>fu.id===u.id));
        if(!o)return true;
        const d=o.orderDate||"";
        return d.startsWith(String(curY2))&&Number(d.slice(5,7))===curM2;
      });
  const filamentCombined = {};
  filteredUsage.filter(u=>!u.isWaste).forEach(u=>{
    // Try inventory first, fall back to groupKey stored on entry
    const inv=inventory.find(i=>i.id===u.inventoryId);
    let key;
    if(inv){
      key=`${inv.brand||"—"} · ${inv.material} · ${inv.color||"—"}`;
    } else if(u.groupKey){
      const parts=u.groupKey.split("||");
      key=`${parts[0]||"—"} · ${parts[1]||"?"} · ${parts[2]||"—"}`;
    } else return;
    filamentCombined[key]=(filamentCombined[key]||0)+num(u.weightUsedG);
  });
  const filCombEntries = Object.entries(filamentCombined).sort((a,b)=>b[1]-a[1]);
  const totalFilUsed = filCombEntries.reduce((s,[_k,v])=>s+v,0);

  const maxOrd = Math.max(1,...thisYearData.map(d=>d.orders));
  const maxRev2 = Math.max(1,...thisYearData.map(d=>d.rev),...prevYearData.map(d=>d.rev));
  const maxCumRev = Math.max(1,...cumulativeRev);
  const maxExp3 = Math.max(1,...thisYearData.map(d=>d.exp));

  // ── Shared components ─────────────────────────────────────────────────────
  const Card = ({children,className=""})=><div className={`bg-white border border-gray-200 rounded-2xl p-4 shadow-sm ${className}`}>{children}</div>;
  const Sec = ({icon,title,sub})=>(
    <div className="flex items-baseline gap-2 mb-3">
      <p className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-1.5"><span>{icon}</span>{title}</p>
      {sub&&<span className="text-[10px] text-gray-300">{sub}</span>}
    </div>
  );

  const KPITile = ({label,value,sub,accent,icon,badge})=>(
    <div className="bg-white border border-gray-200 rounded-xl p-3 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide">{label}</p>
          <p className="text-lg font-black leading-tight mt-0.5 truncate" style={{color:accent}}>{value}</p>
          {sub&&<p className="text-[10px] text-gray-400 mt-0.5 leading-tight">{sub}</p>}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 ml-1">
          <span className="text-xl">{icon}</span>
          {badge&&<span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${badge.pos?"bg-emerald-100 text-emerald-700":"bg-red-100 text-red-600"}`}>{badge.label}</span>}
        </div>
      </div>
    </div>
  );

  const HBar = ({label,value,total,color,suffix="",pct,sub})=>{
    const p=pct!==undefined?pct:(total?Math.round(value/total*100):0);
    return (
      <div className="space-y-0.5">
        <div className="flex justify-between items-baseline gap-1">
          <span className="text-xs text-gray-600 truncate flex-1" title={label}>{label}</span>
          {sub&&<span className="text-[10px] text-gray-400 shrink-0">{sub}</span>}
          <span className="text-[10px] text-gray-400 shrink-0">{p}%</span>
          <span className="text-xs font-bold text-slate-700 shrink-0">{suffix}{typeof value==="number"?fmt(value):value}</span>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{width:`${p}%`,background:color}}/>
        </div>
      </div>
    );
  };

  const Donut = ({data,colors,size=80,centerText,compact=false})=>{
    const total=data.reduce((s,[_k,v])=>s+v,0);
    if(!total)return <p className="text-xs text-gray-300 text-center py-2">No data</p>;
    let cum=0;
    const r=38,cx=50,cy=50;
    const filtered=data.filter(([_k,v])=>v>0);
    const slices=filtered.map(([label,value],i)=>{
      const pct=value/total;
      // Single slice at 100%: draw a full circle instead of arc
      if(filtered.length===1||pct>=0.9999){
        return {isCircle:true,color:colors[i%colors.length],label,value,pct};
      }
      const sa=cum*2*Math.PI-Math.PI/2;
      cum+=pct;
      const ea=cum*2*Math.PI-Math.PI/2;
      const x1=cx+r*Math.cos(sa),y1=cy+r*Math.sin(sa),x2=cx+r*Math.cos(ea),y2=cy+r*Math.sin(ea);
      return {path:`M${cx} ${cy}L${x1} ${y1}A${r} ${r} 0 ${pct>.5?1:0} 1 ${x2} ${y2}Z`,color:colors[i%colors.length],label,value,pct};
    });
    return (
      <div className={compact?"flex items-center gap-2":"flex items-center gap-3"}>
        <svg viewBox="0 0 100 100" style={{width:size,height:size}} className="shrink-0">
          {slices.map((s,i)=>s.isCircle
            ?<circle key={i} cx={cx} cy={cy} r={r} fill={s.color} stroke="white" strokeWidth="1.5"/>
            :<path key={i} d={s.path} fill={s.color} stroke="white" strokeWidth="1.5"/>)}
          <circle cx="50" cy="50" r="22" fill="white"/>
          {centerText&&<text x="50" y="53" textAnchor="middle" fontSize="9" fontWeight="bold" fill="#475569">{centerText}</text>}
        </svg>
        <div className={compact?"flex flex-col gap-0.5":"space-y-0.5 min-w-0 flex-1"}>
          {slices.map((s,i)=>(
            <div key={i} className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-sm shrink-0" style={{background:s.color}}/>
              <span className="text-[10px] text-gray-600 font-medium">{s.label}</span>
              <span className="text-[10px] font-black text-slate-700 ml-0.5">{Math.round(s.pct*100)}%</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Line chart SVG with y-axis
  const fmtTick = (v) => v>=10000000?`${(v/10000000).toFixed(2)}Cr`:v>=100000?`${(v/100000).toFixed(2)}L`:v>=1000?`${(v/1000).toFixed(2)}K`:Number.isInteger(v)?String(v):`${Number(v).toFixed(2)}`;
  const getRoundTick = (max) => {
    if (!max||max<=0) return 1;
    const mag = Math.pow(10,Math.floor(Math.log10(max)));
    return [1,2,2.5,5,10].map(f=>f*mag).find(v=>v>=max/4)||mag;
  };
  const getTopVal = (max) => { const t=getRoundTick(max); return Math.ceil(max/t)*t||1; };

  const BarChart2 = ({data, color="#6366f1", height=160, color2, data2}) => {
    const maxV = Math.max(1,...data.map(d=>d.value),...(data2||[]).map(d=>d.value));
    const topVal = getTopVal(maxV);
    const tick = getRoundTick(maxV);
    const ticks = [];
    for(let v=0;v<=topVal;v+=tick) ticks.push(v);
    const W=720, H=280;
    const YPAD=44, TOP=28, BOT=24, XPAD=24;
    const chartH = H-TOP-BOT;
    const chartW = W-YPAD-XPAD;
    const n = data.length;
    const slotW = chartW/n;
    const barW = data2 ? slotW*0.35 : slotW*0.55;
    const barX = (i) => YPAD + i*slotW + (slotW-(data2?barW*2+3:barW))/2;
    const barH = (v) => Math.max(0,(v/topVal)*chartH);
    const barY = (v) => TOP+chartH-barH(v);
    const barColor = (i) => typeof color==="function"?color(i):color;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{display:"block"}}>
        {ticks.map(v=>{
          const y=TOP+chartH-(v/topVal)*chartH;
          return (
            <g key={v}>
              <line x1={YPAD} y1={y} x2={W-XPAD} y2={y} stroke={v===0?"#94a3b8":"#e2e8f0"} strokeWidth={v===0?1.5:1} strokeDasharray={v===0?"none":"4 2"}/>
              <text x={YPAD-5} y={y+4} textAnchor="end" fontSize="11" fill="#475569" fontWeight="600">{fmtTick(v)}</text>
            </g>
          );
        })}
        <line x1={YPAD} y1={TOP} x2={YPAD} y2={TOP+chartH} stroke="#64748b" strokeWidth="1.5"/>
        {data.map((d,i)=>{
          const h=barH(d.value), x=barX(i), y=barY(d.value);
          const c=barColor(i);
          return (
            <g key={d.label}>
              {h>0&&<rect x={x} y={y} width={barW} height={h} fill={c} rx="2" opacity="0.88"/>}
              {d.value>0&&<text x={x+barW/2} y={y-5} textAnchor="middle" fontSize="9" fill="#1e293b" fontWeight="700">{fmtTick(d.value)}</text>}
              {data2&&(()=>{
                const v2=data2[i]?.value||0, h2=barH(v2), x2=x+barW+3, y2=barY(v2);
                return h2>0?(<g>
                  <rect x={x2} y={y2} width={barW} height={h2} fill={color2||"#6366f144"} rx="2" opacity="0.65"/>
                  <text x={x2+barW/2} y={y2-5} textAnchor="middle" fontSize="8" fill="#94a3b8" fontWeight="600">{fmtTick(v2)}</text>
                </g>):null;
              })()}
              <text x={YPAD+i*slotW+slotW/2} y={H-4} textAnchor="middle" fontSize="11" fill="#64748b" fontWeight="500">{d.label}</text>
            </g>
          );
        })}
      </svg>
    );
  };

  const LineChart = ({series, height=160, showArea=true}) => {
    if (!series.length||!series[0].data.length) return null;
    const n = series[0].data.length;
    const allVals = series.flatMap(s=>s.data);
    const maxV = Math.max(1,...allVals);
    const topVal = getTopVal(maxV);
    const tick = getRoundTick(maxV);
    const ticks = [];
    for(let v=0;v<=topVal;v+=tick) ticks.push(v);
    const W=720, H=280;
    const YPAD=44, TOP=28, BOT=24, XPAD=24;
    const chartH = H-TOP-BOT;
    const chartW = W-YPAD-XPAD;
    const px = (i) => YPAD + (n>1?i/(n-1):0.5)*chartW;
    const py = (v) => TOP + chartH - (v/topVal)*chartH;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{display:"block"}}>
        {ticks.map(v=>{
          const y=py(v);
          return (
            <g key={v}>
              <line x1={YPAD} y1={y} x2={W-XPAD} y2={y} stroke={v===0?"#94a3b8":"#e2e8f0"} strokeWidth={v===0?1.5:1} strokeDasharray={v===0?"none":"4 2"}/>
              <text x={YPAD-5} y={y+4} textAnchor="end" fontSize="11" fill="#475569" fontWeight="600">{fmtTick(v)}</text>
            </g>
          );
        })}
        <line x1={YPAD} y1={TOP} x2={YPAD} y2={TOP+chartH} stroke="#64748b" strokeWidth="1.5"/>
        <line x1={YPAD} y1={TOP+chartH} x2={W-XPAD} y2={TOP+chartH} stroke="#64748b" strokeWidth="1.5"/>
        {series.map((s,si)=>{
          const pts=s.data.map((v,i)=>`${px(i)},${py(v)}`).join(" ");
          const area=`M${px(0)},${py(0)} ${s.data.map((v,i)=>`L${px(i)},${py(v)}`).join(" ")} L${px(n-1)},${py(0)} Z`;
          return (
            <g key={si}>
              {showArea&&<path d={area} fill={s.color} opacity="0.1"/>}
              <polyline points={pts} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
              {s.data.map((v,i)=>v>0&&(
                <g key={i}>
                  <circle cx={px(i)} cy={py(v)} r="3.5" fill={s.color} stroke="white" strokeWidth="1.5"/>
                  <text x={px(i)} y={py(v)-8} textAnchor="middle" fontSize="9" fill={s.color} fontWeight="700">{fmtTick(v)}</text>
                </g>
              ))}
            </g>
          );
        })}
        {series[0].labels&&series[0].labels.map((l,i)=>(
          <text key={i} x={px(i)} y={H-4} textAnchor="middle" fontSize="11" fill="#64748b" fontWeight="500">{l}</text>
        ))}
      </svg>
    );
  };


  const ChartCard = ({title, icon, sub, children, legend, extra}) => {
    const [fullscreen, setFullscreen] = useState(false);
    const ref = useRef(null);

    const downloadChart = () => {
      const svg = ref.current?.querySelector("svg");
      if (!svg) return;
      const data = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([data], {type:"image/svg+xml"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${title.replace(/[^a-z0-9]/gi,"-")}.svg`;
      a.click(); URL.revokeObjectURL(url);
    };

    return (
      <>
        <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
          <div className="flex items-start justify-between mb-3">
            <div>
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-1.5"><span>{icon}</span>{title}{sub&&<span className="text-[10px] text-gray-300 font-normal normal-case tracking-normal ml-1">{sub}</span>}</p>
            </div>
            <div className="flex gap-1 shrink-0 ml-2">
              {extra}
              <button onClick={downloadChart} title="Download SVG" className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-all">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
              <button onClick={()=>setFullscreen(true)} title="Fullscreen" className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-all">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
              </button>
            </div>
          </div>
          <div ref={ref}>{children}{legend&&<div className="flex flex-wrap gap-3 mt-2">{legend}</div>}</div>
        </div>
        {fullscreen&&(
          <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" onClick={()=>setFullscreen(false)}>
            <div className="bg-white rounded-2xl p-6 shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-auto" onClick={e=>e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm font-bold text-slate-800 flex items-center gap-2"><span>{icon}</span>{title}</p>
                <div className="flex gap-2">
                  <button onClick={downloadChart} className="flex items-center gap-1.5 text-xs border border-gray-200 text-gray-600 hover:bg-gray-50 px-3 py-1.5 rounded-lg">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Download
                  </button>
                  <button onClick={()=>setFullscreen(false)} className="text-xs border border-gray-200 text-gray-600 hover:bg-gray-50 px-3 py-1.5 rounded-lg">✕ Close</button>
                </div>
              </div>
              <div>{children}{legend&&<div className="flex flex-wrap gap-3 mt-3">{legend}</div>}</div>
            </div>
          </div>
        )}
      </>
    );
  };

  // ── Sections ──────────────────────────────────────────────────────────────
  const SECTIONS = [
    {id:"overview",  label:"Overview",  icon:"⚡"},
    {id:"trends",    label:"Trends",    icon:"📉"},
    {id:"orders",    label:"Orders",    icon:"📋"},
    {id:"finance",   label:"Finance",   icon:"💰"},
    {id:"filament",  label:"Filament",  icon:"🧵"},
    {id:"customers", label:"Clients",   icon:"👥"},
    {id:"referrals", label:"Referrals",  icon:"🤝"},
  ];

  return (
    <div className="space-y-4">
      {/* Nav */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 sticky top-0 z-10 overflow-x-auto scrollbar-none">
        {SECTIONS.filter(s=>canSection(s.id)).map(s=>(
          <button key={s.id} onClick={()=>setSection(s.id)}
            className={`flex-1 flex-shrink-0 flex items-center justify-center gap-1 rounded-lg font-semibold transition-all py-2 px-1.5 md:px-3 ${section===s.id?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700"}`}>
            <span className="text-sm leading-none">{s.icon}</span>
            <span className="text-[10px] md:text-xs whitespace-nowrap">{s.label}</span>
          </button>
        ))}
      </div>

      {canSection(section)&&(
        <div className="flex items-center gap-2 justify-end">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {["month","year"].map(p=><button key={p} onClick={()=>setPeriod(p)} className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${period===p?"bg-white text-indigo-700 shadow-sm":"text-gray-500"}`}>{p==="month"?"Monthly":"Yearly"}</button>)}
          </div>
          {period==="month"&&<select value={year} onChange={e=>setYear(Number(e.target.value))} className="border border-gray-200 rounded-lg px-2 py-1 text-xs bg-white focus:outline-none">
            {(years.length?years:[String(year)]).map(y=><option key={y} value={y}>{y}</option>)}
          </select>}
        </div>
      )}

      {/* ── OVERVIEW ─────────────────────────────────────────────────────── */}
      {section==="overview"&&canSection("overview")&&(
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <KPITile label="Total Collected" value={fmtK(totalPaid)} sub={`Revenue: ${fmtK(totalRev)}`} accent="#6366f1" icon="💰" badge={yoyGrowth!==null?{pos:yoyGrowth>=0,label:`${yoyGrowth>=0?"+":""}${yoyGrowth}% YoY`}:null}/>
            <KPITile label="Order Value (Net)" value={fmtK(totalOrderValue)} sub={`Gross: ${fmtK(totalOrderValueGross)}`} accent="#10b981" icon="📋"/>
            <KPITile label="Net Profit" value={fmtK(netProfit)} sub={`${profitMargin}% margin`} accent={netProfit>=0?"#10b981":"#f43f5e"} icon={netProfit>=0?"📈":"📉"}/>
            <KPITile label="Total Expenses" value={fmtK(totalExp)} sub={`${expCats.length} categories`} accent="#f59e0b" icon="💸"/>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <KPITile label="Avg Order Value" value={fmtK(avgOrder)} sub={`${completedOrders} completed`} accent="#8b5cf6" icon="🎯"/>
            <KPITile label="Outstanding" value={fmtK(totalOutstanding)} sub="balance due" accent="#f43f5e" icon="⏰"/>
            <KPITile label="Filament Used" value={totalUsedG>=1000?`${(totalUsedG/1000).toFixed(1)}kg`:`${fmt(totalUsedG)}g`} sub={`${wasteRate}% waste rate`} accent="#22d3ee" icon="🧵"/>
            <KPITile label="Projected Next Month" value={projNextMonth>0?fmtK(projNextMonth):"—"} sub="based on trend" accent="#84cc16" icon="🔮"/>
          </div>

          {/* Health dials */}
          <Card>
            <Sec icon="🏥" title="Business Health Score"/>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                {label:"Collection Rate",value:collectionRate,color:collectionRate>=80?"#10b981":collectionRate>=50?"#f59e0b":"#f43f5e",desc:collectionRate>=80?"Excellent":collectionRate>=50?"Fair":"Needs attention"},
                {label:"Profit Margin",value:profitMargin,color:profitMargin>=30?"#10b981":profitMargin>=10?"#f59e0b":"#f43f5e",desc:profitMargin>=30?"Healthy":profitMargin>=10?"Moderate":profitMargin>=0?"Thin":"Loss"},
                {label:"Completion Rate",value:totalOrders?Math.round(completedOrders/totalOrders*100):0,color:"#6366f1",desc:`${completedOrders}/${totalOrders} orders`},
                {label:"Waste Efficiency",value:Math.round((100-Number(wasteRate))*10)/10,color:Number(wasteRate)<5?"#10b981":Number(wasteRate)<15?"#f59e0b":"#f43f5e",desc:`${wasteRate}% waste`},
              ].map(({label,value,color,desc})=>(
                <div key={label} className="text-center">
                  <div className="relative w-20 h-20 mx-auto">
                    <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                      <circle cx="18" cy="18" r="14" fill="none" stroke="#f1f5f9" strokeWidth="3"/>
                      <circle cx="18" cy="18" r="14" fill="none" stroke={color} strokeWidth="3" strokeDasharray={`${Math.max(0,Math.abs(value))*87.96/100} 87.96`} strokeLinecap="round"/>
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center text-xs font-black" style={{color}}>{value<0?"":""}{value}%</span>
                  </div>
                  <p className="text-[10px] font-bold text-gray-500 mt-1">{label}</p>
                  <p className="text-[9px] text-gray-300">{desc}</p>
                </div>
              ))}
            </div>
          </Card>

          {/* Revenue + expense overview bars */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ChartCard icon="📊" title={period==="year"?"Revenue by Year":"Revenue This Year"} sub={chartLabel}
              legend={[
                <span key="a" className="flex items-center gap-1 text-xs text-gray-400"><span className="w-2 h-2 rounded-sm bg-indigo-500 inline-block"/>{year}</span>,
                <span key="b" className="flex items-center gap-1 text-xs text-gray-400"><span className="w-2 h-2 rounded-sm inline-block" style={{background:"#6366f144"}}/>{year-1}</span>
              ]}>
              <BarChart2 data={chartData.map(d=>({label:d.label,value:d.rev}))} color="#6366f1"
                data2={period==="month"?prevYearData.map(d=>({label:d.label,value:d.rev})):undefined} color2="#6366f144"/>
            </ChartCard>
            <Card>
              <Sec icon="💸" title="Expense Categories"/>
              <div className="space-y-1.5">
                {expCats.slice(0,6).map(([cat,amt],i)=>(
                  <HBar key={cat} label={cat} value={amt} total={totalExp} color={bc(i)} pct={totalExp?Math.round(amt/totalExp*100):0}/>
                ))}
                {expCats.length>6&&<p className="text-[10px] text-gray-400">+{expCats.length-6} more</p>}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ── TRENDS ───────────────────────────────────────────────────────── */}
      {section==="trends"&&canSection("trends")&&(
        <div className="space-y-3">
          {/* Cumulative revenue line */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <ChartCard icon="📈" title="Cumulative Revenue & Profit" sub={`${year}`}
                legend={[["Revenue","#6366f1"],["Expenses","#f59e0b"],["Profit","#10b981"]].map(([l,c])=>(
                  <span key={l} className="flex items-center gap-1 text-xs text-gray-400"><span className="w-2 h-2 rounded-sm inline-block" style={{background:c}}/>{l}</span>
                ))}>
                <LineChart series={[{data:cumulativeRev,color:"#6366f1",labels:MONTHS},{data:cumulativeExp,color:"#f59e0b"},{data:cumulativeProfit.map(v=>Math.max(0,v)),color:"#10b981"}]}/>
              </ChartCard>
            </div>
            <Card>
              <Sec icon="📋" title="Year Summary"/>
              <div className="space-y-3">
                {[["Revenue",cumulativeRev[cumulativeRev.length-1]||0,"#6366f1"],["Expenses",cumulativeExp[cumulativeExp.length-1]||0,"#f59e0b"],["Profit",(cumulativeRev[cumulativeRev.length-1]||0)-(cumulativeExp[cumulativeExp.length-1]||0),((cumulativeRev[cumulativeRev.length-1]||0)-(cumulativeExp[cumulativeExp.length-1]||0))>=0?"#10b981":"#f43f5e"]].map(([l,v,c])=>(
                  <div key={l} className="flex items-center justify-between py-1 border-b border-gray-50"><span className="text-xs text-gray-500">{l}</span><span className="text-sm font-black" style={{color:c}}>{fmtK(v)}</span></div>
                ))}
                <div className="pt-1">{yoyGrowth!==null?<><p className="text-[10px] text-gray-400">YoY Growth</p><p className={`text-xl font-black ${yoyGrowth>=0?"text-emerald-600":"text-red-500"}`}>{yoyGrowth>=0?"+":""}{yoyGrowth}%</p></>:<p className="text-xs text-gray-300">No prev year</p>}</div>
              </div>
            </Card>
          </div>

          {/* MoM trend */}
          <Card>
            <Sec icon="📉" title="Month-over-Month Revenue Trend" sub={String(year)}/>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-gray-100">
                  {["Month","Revenue","vs Prev Year","Expenses","Profit","MoM Δ"].map(h=>(
                    <th key={h} className={`py-1.5 font-semibold text-gray-400 ${h==="Month"?"text-left":"text-right"}`}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {thisYearData.map((d,i)=>{
                    const prev=i>0?thisYearData[i-1].rev:null;
                    const mom=prev!==null&&prev>0?((d.rev-prev)/prev*100):null;
                    const yoy=prevYearData[i].rev>0?((d.rev-prevYearData[i].rev)/prevYearData[i].rev*100):null;
                    const profit=d.rev-d.exp;
                    return (
                      <tr key={d.label} className="border-b border-gray-200 hover:bg-slate-50">
                        <td className="py-1.5 font-semibold text-slate-700">{d.label}</td>
                        <td className="py-1.5 text-right font-semibold text-indigo-700">{d.rev>0?fmtK(d.rev):"—"}</td>
                        <td className="py-1.5 text-right">{yoy!==null&&d.rev>0?<span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${yoy>=0?"bg-emerald-100 text-emerald-700":"bg-red-100 text-red-600"}`}>{yoy>=0?"+":""}{yoy.toFixed(1)}%</span>:<span className="text-gray-200">—</span>}</td>
                        <td className="py-1.5 text-right text-amber-600">{d.exp>0?fmtK(d.exp):"—"}</td>
                        <td className={`py-1.5 text-right font-semibold ${profit>0?"text-emerald-600":profit<0?"text-red-500":"text-gray-300"}`}>{d.rev>0||d.exp>0?fmtK(profit):"—"}</td>
                        <td className="py-1.5 text-right">{mom!==null&&d.rev>0?<span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${mom>=0?"bg-emerald-100 text-emerald-700":"bg-red-100 text-red-600"}`}>{mom>=0?"+":""}{mom.toFixed(1)}%</span>:<span className="text-gray-200">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Revenue line YoY comparison */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <ChartCard icon="🔁" title="YoY Revenue Comparison" sub={`${year-1} vs ${year}`}
                legend={[<span key="a" className="flex items-center gap-1 text-xs text-gray-400"><span className="w-2 h-2 rounded-sm bg-indigo-500 inline-block"/>{year}</span>,<span key="b" className="flex items-center gap-1 text-xs text-gray-400"><span className="w-3 h-0.5 inline-block" style={{background:"#6366f180"}}/>{year-1}</span>,yoyGrowth!==null&&<span key="c" className={`text-xs font-bold px-2 py-0.5 rounded-full ${yoyGrowth>=0?"bg-emerald-100 text-emerald-700":"bg-red-100 text-red-600"}`}>YoY: {yoyGrowth>=0?"+":""}{yoyGrowth}%</span>].filter(Boolean)}>
                <LineChart series={[{data:thisYearData.map(d=>d.rev),color:"#6366f1",labels:MONTHS},{data:prevYearData.map(d=>d.rev),color:"#6366f144"}]} showArea={false}/>
              </ChartCard>
            </div>
            <Card>
              <Sec icon="📊" title="Best vs Worst"/>
              {(()=>{const best=thisYearData.reduce((b,d)=>d.rev>b.rev?d:b,{rev:0,label:"—"});const nonZero=thisYearData.filter(d=>d.rev>0);const worst=nonZero.length?nonZero.reduce((b,d)=>d.rev<b.rev?d:b):{rev:0,label:"—"};return(<div className="space-y-3"><div><p className="text-[10px] text-gray-400 uppercase">Best Month</p><p className="text-xl font-black text-emerald-600">{best.label}</p><p className="text-xs text-gray-500">{fmtK(best.rev)}</p></div><div><p className="text-[10px] text-gray-400 uppercase">Lowest Month</p><p className="text-xl font-black text-orange-500">{worst.label}</p><p className="text-xs text-gray-500">{fmtK(worst.rev)}</p></div><div className="pt-2 border-t border-gray-100"><p className="text-[10px] text-gray-400 uppercase">Prev Year Total</p><p className="text-sm font-black text-gray-600">{fmtK(prevYearRev)}</p></div></div>);})()}
            </Card>
          </div>

          {/* Revenue growth rate line */}
          <ChartCard icon="🚀" title="Monthly Revenue Growth Rate" sub={String(year)}>
            <div>
            {(()=>{
              const growthRates = thisYearData.map((d,i)=>{
                if(i===0||thisYearData[i-1].rev===0)return 0;
                return Math.round((d.rev-thisYearData[i-1].rev)/thisYearData[i-1].rev*100);
              });
              const hasData = growthRates.some(v=>v!==0);
              if(!hasData)return <p className="text-xs text-gray-300 text-center py-4">Not enough data yet</p>;
              return (
                <>
                  {(()=>{
                    const maxAbs = Math.max(5,...growthRates.map(Math.abs));
                    const halfH = 80;
                    return (
                      <div className="flex gap-1">
                        <div className="flex flex-col justify-between shrink-0" style={{width:24,height:halfH*2}}>
                          <span className="text-[9px] text-gray-400 text-right">+{maxAbs}%</span>
                          <span className="text-[9px] text-gray-400 text-right">0%</span>
                          <span className="text-[9px] text-gray-400 text-right">-{maxAbs}%</span>
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-0.5 border-l border-gray-200" style={{height:halfH*2}}>
                            {growthRates.map((v,i)=>(
                              <div key={i} className="flex-1 flex flex-col h-full" title={`${MONTHS[i]}: ${v>=0?"+":""}${v}%`}>
                                <div className="flex-1 flex items-end">
                                  {v>0&&<div className="w-full rounded-t-sm" style={{height:`${Math.round((v/maxAbs)*halfH)}px`,background:"#10b981"}}/>}
                                </div>
                                <div className="h-px w-full bg-gray-200"/>
                                <div className="flex-1 flex items-start">
                                  {v<0&&<div className="w-full rounded-b-sm" style={{height:`${Math.round((Math.abs(v)/maxAbs)*halfH)}px`,background:"#f43f5e"}}/>}
                                </div>
                              </div>
                            ))}
                          </div>
                          <div className="flex gap-0.5 mt-1 border-t border-transparent">
                            {MONTHS.map(m=><p key={m} className="flex-1 text-[9px] text-gray-500 text-center">{m}</p>)}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </>
              );
            })()}
            </div>
          </ChartCard>

          {/* Trending products — top of trends */}
          {(()=>{
            const curDate = new Date();
            const curM = curDate.getMonth()+1, curY = curDate.getFullYear();
            const filterOrds = period==="year"
              ? orders.filter(o=>o.status!=="Cancelled")
              : orders.filter(o=>{const d=o.orderDate||"";return d.startsWith(String(year))&&Number(d.slice(5,7))===curM;});
            const periodLabel = period==="year" ? String(year) : `${MONTHS[curM-1]} ${year}`;

            // Overall top products
            const itemCount = {};
            filterOrds.forEach(o=>{
              (o.items||[]).forEach(it=>{
                if(!it.item)return;
                if(!itemCount[it.item])itemCount[it.item]={count:0,rev:0};
                itemCount[it.item].count+=num(it.qty||1);
                itemCount[it.item].rev+=num(it.netAmt);
              });
            });
            const topItems=Object.entries(itemCount).sort((a,b)=>b[1].rev-a[1].rev).slice(0,8);
            const maxR=Math.max(1,...topItems.map(([_k,v])=>v.rev));

            // By channel
            const channels=[...new Set(filterOrds.map(o=>o.channel||"Offline"))].sort();
            const channelItems={};
            channels.forEach(ch=>{
              const chMap={};
              filterOrds.filter(o=>(o.channel||"Offline")===ch).forEach(o=>{
                (o.items||[]).forEach(it=>{
                  if(!it.item)return;
                  if(!chMap[it.item])chMap[it.item]={count:0,rev:0};
                  chMap[it.item].count+=num(it.qty||1);
                  chMap[it.item].rev+=num(it.netAmt);
                });
              });
              channelItems[ch]=Object.entries(chMap).sort((a,b)=>b[1].rev-a[1].rev).slice(0,5);
            });

            return (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Card>
                  <Sec icon="🔥" title="Top Products" sub={periodLabel}/>
                  {topItems.length===0?<p className="text-xs text-gray-300 text-center py-4">No data</p>:(
                    <div className="space-y-2">
                      {topItems.map(([item,{count,rev}],i)=>(
                        <div key={item} className="space-y-0.5">
                          <div className="flex items-baseline gap-2">
                            <span className="text-[10px] font-black text-gray-200 w-4 shrink-0">{i+1}</span>
                            <span className="text-xs text-gray-700 font-medium flex-1 truncate">{item}</span>
                            <span className="text-[10px] text-gray-400 shrink-0">{count} units</span>
                            <span className="text-xs font-bold text-indigo-600 shrink-0">{fmtK(rev)}</span>
                          </div>
                          <div className="ml-5 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-indigo-400" style={{width:`${Math.round(rev/maxR*100)}%`}}/>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
                <Card>
                  <Sec icon="📍" title="Top Products by Channel" sub={periodLabel}/>
                  {channels.length===0?<p className="text-xs text-gray-300 text-center py-4">No data</p>:(
                    <div className="space-y-3">
                      {channels.map(ch=>(
                        <div key={ch}>
                          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1">{ch}</p>
                          {channelItems[ch].length===0?<p className="text-xs text-gray-200">No orders</p>:(
                            <div className="space-y-0.5">
                              {channelItems[ch].map(([item,{count,rev}],i)=>(
                                <div key={item} className="flex items-center gap-2">
                                  <span className="text-[9px] text-gray-300 w-3 shrink-0">{i+1}</span>
                                  <span className="text-[10px] text-gray-600 flex-1 truncate">{item}</span>
                                  <span className="text-[10px] text-gray-400 shrink-0">{count}×</span>
                                  <span className="text-[10px] font-bold text-indigo-500 shrink-0">{fmtK(rev)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            );
          })()}

          {/* Projection */}
          {projNextMonth>0&&(
            <Card>
              <Sec icon="🔮" title="Revenue Projection"/>
              <div className="flex items-center gap-6">
                <div>
                  <p className="text-3xl font-black text-indigo-700">{fmtK(projNextMonth)}</p>
                  <p className="text-xs text-gray-400 mt-1">Projected next month</p>
                  <p className="text-[10px] text-gray-300 mt-0.5">Based on last 3-month avg growth rate</p>
                </div>
                <div className="flex-1 space-y-2">
                  {nonZeroMonths.slice(-3).map((m,i)=>(
                    <div key={m.label} className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 w-8 shrink-0">{m.label}</span>
                      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-indigo-400" style={{width:`${Math.round(m.rev/Math.max(projNextMonth,...nonZeroMonths.slice(-3).map(x=>x.rev))*100)}%`}}/>
                      </div>
                      <span className="text-xs font-semibold text-slate-600 shrink-0">{fmtK(m.rev)}</span>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-indigo-600 w-8 shrink-0">Next</span>
                    <div className="flex-1 h-2 bg-indigo-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-indigo-500" style={{width:"100%"}}/>
                    </div>
                    <span className="text-xs font-bold text-indigo-700 shrink-0">{fmtK(projNextMonth)}</span>
                  </div>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ── ORDERS ───────────────────────────────────────────────────────── */}
      {section==="orders"&&canSection("orders")&&(
        <div className="space-y-3">
          {/* Order Stats at top — full width grid */}
          <Card>
            <Sec icon="📊" title="Order Stats"/>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {[
                ["Total Orders", totalOrders, "#6366f1"],
                ["Completed", completedOrders, "#10b981"],
                ["Pending", pendingOrders, "#f59e0b"],
                ["Cancelled", cancelledOrders, "#f43f5e"],
                ["B2B Revenue", fmtK(completedRevOrders.filter(o=>o.type==="B2B").reduce((s,o)=>s+getInvoicedAmt(o),0)), "#6366f1"],
                ["B2C Revenue", fmtK(completedRevOrders.filter(o=>o.type==="B2C").reduce((s,o)=>s+getInvoicedAmt(o),0)), "#22d3ee"],
                ["GST Revenue", fmtK(completedRevOrders.filter(o=>o.needsGst||taxInvoices.some(t=>t.orderId===o.orderNo)).reduce((s,o)=>s+getInvoicedAmt(o),0)), "#10b981"],
                ["Non-GST Revenue", fmtK(completedRevOrders.filter(o=>!o.needsGst&&!taxInvoices.some(t=>t.orderId===o.orderNo)).reduce((s,o)=>s+getInvoicedAmt(o),0)), "#f59e0b"],
                ["Online Revenue", fmtK(completedRevOrders.filter(o=>(o.channel||"Offline")!=="Offline").reduce((s,o)=>s+getInvoicedAmt(o),0)), "#0ea5e9"],
                ["Offline Revenue", fmtK(completedRevOrders.filter(o=>(o.channel||"Offline")==="Offline").reduce((s,o)=>s+getInvoicedAmt(o),0)), "#84cc16"],
                ["Online Orders", periodActiveOrders.filter(o=>(o.channel||"Offline")!=="Offline").length, "#0ea5e9"],
                ["Offline Orders", periodActiveOrders.filter(o=>(o.channel||"Offline")==="Offline").length, "#84cc16"],
              ].map(([l,v,c])=>(
                <div key={l} className="bg-gray-50 rounded-xl p-3">
                  <p className="text-[10px] text-gray-400 font-medium">{l}</p>
                  <p className="text-lg font-black mt-0.5" style={{color:c}}>{v}</p>
                </div>
              ))}
            </div>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ChartCard icon="📈" title="Orders Over Time">
              <BarChart2 data={chartData.map(d=>({label:d.label,value:d.orders}))} color={(i)=>bc(i)}/>
            </ChartCard>
            <ChartCard icon="💹" title="Avg Order Value Trend">
              <LineChart series={[{data:chartData.map(d=>d.orders>0?Math.round(d.rev/d.orders):0),color:"#8b5cf6",labels:chartData.map(d=>d.label)}]}/>
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ChartCard icon="🛒" title="Sales Channel">
              <Donut data={Object.entries(channelMap).sort((a,b)=>b[1]-a[1])} colors={PALETTE} size={180}/>
            </ChartCard>
            <Card>
              <Sec icon="💳" title="Payment Modes"/>
              {Object.keys(modeMap).length===0?<p className="text-xs text-gray-300 text-center py-3">No data</p>:(
                <div className="space-y-1.5">
                  {Object.entries(modeMap).sort((a,b)=>b[1]-a[1]).map(([mode,cnt],i)=>{
                    const tot=Object.values(modeMap).reduce((s,v)=>s+v,0);
                    return <HBar key={mode} label={mode} value={cnt} total={tot} color={bc(i)} pct={Math.round(cnt/tot*100)}/>;
                  })}
                </div>
              )}
            </Card>
          </div>


        </div>
      )}

      {/* ── FINANCE ──────────────────────────────────────────────────────── */}
      {section==="finance"&&canSection("finance")&&(
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <KPITile label="Collected" value={fmtK(totalPaid)} sub={`Revenue: ${fmtK(totalRev)}`} accent="#6366f1" icon="💰"/>
            <KPITile label="Order Value (Net)" value={fmtK(totalOrderValue)} sub={`Gross: ${fmtK(totalOrderValueGross)}`} accent="#10b981" icon="📋"/>
            <KPITile label="Outstanding" value={fmtK(totalOutstanding)} sub="balance due" accent="#f43f5e" icon="⏰"/>
            <KPITile label="Net Profit" value={fmtK(netProfit)} sub={`${profitMargin}% margin`} accent={netProfit>=0?"#10b981":"#f43f5e"} icon="🏦"/>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Card>
              <Sec icon="💸" title="Expenses by Category"/>
              {expCats.length===0?<p className="text-xs text-gray-300 text-center py-4">No data</p>:(
                <div className="space-y-1.5">
                  {expCats.map(([cat,amt],i)=>(
                    <HBar key={cat} label={cat} value={amt} total={totalExp} color={bc(i)} pct={totalExp?Math.round(amt/totalExp*100):0}/>
                  ))}
                </div>
              )}
            </Card>
            <Card>
              <Sec icon="📅" title={period==="year"?"Yearly Expense Trend":"Monthly Expense Trend"} sub={chartLabel}/>
              <BarChart2 data={thisYearData.map(d=>({label:d.label,value:d.exp}))} color="#f59e0b" height={160}/>
              <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-gray-100">
                <div><p className="text-[10px] text-gray-400 uppercase tracking-wide">Total</p><p className="text-base font-black text-amber-600">{fmtK(totalExp)}</p></div>
                <div><p className="text-[10px] text-gray-400 uppercase tracking-wide">Avg/Month</p><p className="text-base font-black text-slate-700">{fmtK(totalExp/12)}</p></div>
              </div>
            </Card>
          </div>

          <Card>
            <Sec icon="🔁" title="Expense vs Revenue Line" sub={String(year)}/>
            <LineChart
              series={[
                {data:thisYearData.map(d=>d.rev),color:"#6366f1",labels:MONTHS},
                {data:thisYearData.map(d=>d.exp),color:"#f59e0b"},
              ]}
              height={160}
            />
            <div className="flex gap-4 mt-1">
              <span className="flex items-center gap-1 text-xs text-gray-400"><span className="w-2 h-2 rounded-sm bg-indigo-500 inline-block"/>Revenue</span>
              <span className="flex items-center gap-1 text-xs text-gray-400"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block"/>Expenses</span>
            </div>
          </Card>


        </div>
      )}

      {/* ── FILAMENT ─────────────────────────────────────────────────────── */}
      {section==="filament"&&canSection("filament")&&(
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <KPITile label="Total Used" value={totalUsedG>=1000?`${(totalUsedG/1000).toFixed(1)}kg`:`${fmt(totalUsedG)}g`} sub="across all orders" accent="#6366f1" icon="🧵"/>
            <KPITile label="Total Waste" value={`${fmt(totalWasteG)}g`} sub={`${wasteRate}% waste rate`} accent="#f43f5e" icon="♻️"/>
            <KPITile label="Spools" value={inventory.length} sub={`${[...new Set(inventory.map(i=>i.material))].length} materials`} accent="#10b981" icon="📦"/>
            <KPITile label="Stock Left" value={`${(inventory.reduce((s,i)=>s+num(i.weightG),0)/1000).toFixed(1)}kg`} sub="total" accent="#f59e0b" icon="🏪"/>
          </div>

          {/* Combined brand·material·color */}
          <ChartCard icon="📊" title="Filament Usage — Brand · Material · Color" sub={period==="year"?String(year):`${MONTHS[new Date().getMonth()]} ${new Date().getFullYear()}`}>
            {filCombEntries.length===0?<p className="text-xs text-gray-300 text-center py-6">No filament usage recorded</p>:(
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                {/* Left: donut + legend */}
                <div>
                  <Donut data={filCombEntries.slice(0,12)} colors={PALETTE} size={160} centerText={`${filCombEntries.length} types`}/>
                </div>
                {/* Right: HBars */}
                <div className="space-y-2">
                  {filCombEntries.map(([k,v],i)=>(
                    <HBar key={k} label={k} value={v>=1000?`${(v/1000).toFixed(1)}kg`:`${Math.round(v)}g`} total={totalFilUsed} color={bc(i)} pct={Math.round(v/totalFilUsed*100)}/>
                  ))}
                </div>
              </div>
            )}
          </ChartCard>

          {/* Usage over time */}
          <Card>
            <Sec icon="📈" title="Filament Usage Over Time"/>
            {(()=>{
              const usageByMonth = MONTHS.map((m,i)=>{
                const ordersThatMonth = orders.filter(o=>{const d=o.orderDate||"";return d.startsWith(String(year))&&Number(d.slice(5,7))===i+1;});
                const used = ordersThatMonth.flatMap(o=>o.filamentUsage||[]).filter(u=>!u.isWaste).reduce((s,u)=>s+num(u.weightUsedG),0);
                return {label:m, value:used};
              });
              const maxU = Math.max(1,...usageByMonth.map(d=>d.value));
              return <BarChart2 data={usageByMonth} color="#6366f1" height={160}/>;
            })()}
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Card>
              <Sec icon="🗑️" title="Wastage by Brand · Material · Color"/>
              {wastageLog.length===0?<p className="text-xs text-gray-300 text-center py-4">No wastage recorded</p>:(()=>{
                const wComb = {};
                wastageLog.forEach(w=>{
                  const k=`${w.brand||"—"} · ${w.material||"?"} · ${w.color||"—"}`;
                  wComb[k]=(wComb[k]||0)+num(w.weightG);
                });
                const entries = Object.entries(wComb).sort((a,b)=>b[1]-a[1]);
                const total = entries.reduce((s,[_k,v])=>s+v,0);
                return (
                  <div className="space-y-1.5">
                    {entries.map(([k,v],i)=>(
                      <HBar key={k} label={k} value={`${Math.round(v)}g`} total={total} color="#fb923c" pct={Math.round(v/total*100)}/>
                    ))}
                  </div>
                );
              })()}
            </Card>
            <Card>
              <Sec icon="📦" title="Inventory by Material"/>
              {inventory.length===0?<p className="text-xs text-gray-300 text-center py-4">No inventory</p>:(()=>{
                const byMat={};
                inventory.forEach(i=>{byMat[i.material]=(byMat[i.material]||{cnt:0,wt:0});byMat[i.material].cnt++;byMat[i.material].wt+=num(i.weightG);});
                const entries=Object.entries(byMat).sort((a,b)=>b[1].wt-a[1].wt);
                const totalWt=entries.reduce((s,[_k,v])=>s+v.wt,0);
                return (
                  <div className="space-y-1.5">
                    {entries.map(([mat,{cnt,wt}],i)=>(
                      <HBar key={mat} label={mat} value={`${cnt} spools · ${(wt/1000).toFixed(1)}kg`} total={totalWt} color={bc(i)} pct={Math.round(wt/totalWt*100)}/>
                    ))}
                  </div>
                );
              })()}
            </Card>
          </div>
        </div>
      )}

      {/* ── CUSTOMERS ────────────────────────────────────────────────────── */}
      {section==="customers"&&canSection("customers")&&(
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <KPITile label="Total Clients" value={Object.keys(custMap).length} sub={`${activeOrders.filter(o=>o.type==="B2B").length} B2B orders`} accent="#6366f1" icon="👥"/>
            <KPITile label="Repeat Clients" value={Object.values(custMap).filter(c=>c.orders>1).length} sub="2+ orders" accent="#10b981" icon="🔄"/>
            <KPITile label="Avg Order Value" value={fmtK(avgOrder)} sub="per order" accent="#8b5cf6" icon="🎯"/>
            <KPITile label="Top Client" value={topCustomers[0]?.name.split(" ")[0]||"—"} sub={topCustomers[0]?fmtK(topCustomers[0].value):""} accent="#f59e0b" icon="🏆"/>
          </div>

          <Card>
            <Sec icon="🏆" title="Top Clients by Revenue"/>
            {topCustomers.length===0?<p className="text-xs text-gray-300 text-center py-4">No data</p>:(
              <div className="space-y-3">
                {topCustomers.map((c,i)=>{
                  const maxV=topCustomers[0].value||1;
                  const cr=c.value?Math.round(c.paid/c.value*100):0;
                  return (
                    <div key={c.name} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-black text-gray-200 w-4 shrink-0">{i+1}</span>
                        <span className="text-xs font-semibold text-slate-700 flex-1 truncate">{c.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold shrink-0 ${c.type==="B2B"?"bg-indigo-100 text-indigo-700":"bg-cyan-100 text-cyan-700"}`}>{c.type}</span>
                        <span className="text-xs font-bold text-slate-700 shrink-0">{fmtK(c.value)}</span>
                        <span className="text-[10px] text-gray-400 shrink-0">{c.orders} orders</span>
                        <span className={`text-[10px] font-bold shrink-0 ${cr>=80?"text-emerald-500":cr>=50?"text-amber-500":"text-red-400"}`}>{cr}% paid</span>
                      </div>
                      <div className="flex items-center gap-2 pl-6">
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{width:`${Math.round(c.value/maxV*100)}%`,background:bc(i)}}/>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Card>
              <Sec icon="🗓️" title="Order Frequency Distribution"/>
              {(()=>{
                const dist={"1 order":0,"2 orders":0,"3 orders":0,"4+ orders":0};
                Object.values(custMap).forEach(c=>{
                  if(c.orders===1)dist["1 order"]++;
                  else if(c.orders===2)dist["2 orders"]++;
                  else if(c.orders===3)dist["3 orders"]++;
                  else dist["4+ orders"]++;
                });
                const total=Object.values(custMap).length||1;
                return (
                  <div className="space-y-2">
                    {Object.entries(dist).map(([k,v],i)=>(
                      <HBar key={k} label={k} value={v} total={total} color={bc(i)} pct={Math.round(v/total*100)}/>
                    ))}
                  </div>
                );
              })()}
            </Card>
            <Card>
              <Sec icon="📅" title={period==="year"?"Orders per Year":"Orders per Month"} sub={chartLabel}/>
              <BarChart2 data={thisYearData.map(d=>({label:d.label,value:d.orders}))} color={(i)=>bc(i)} height={160}/>
            </Card>
          </div>
        </div>
      )}

      {/* ── REFERRALS ─────────────────────────────────────────────────────── */}
      {section==="referrals"&&canSection("referrals")&&(
        <div className="space-y-3">
          {(()=>{
            const refOrders = orders.filter(o=>o.isReferred);
            const paidRefs = refOrders.filter(o=>o.referralPaid);
            const unpaidRefs = refOrders.filter(o=>!o.referralPaid&&o.isReferred);
            const totalRefAmt = refOrders.reduce((s,o)=>s+num(o.referralAmount),0);
            const paidRefAmt = paidRefs.reduce((s,o)=>s+num(o.referralAmount),0);
            const unpaidRefAmt = unpaidRefs.reduce((s,o)=>s+num(o.referralAmount),0);
            const personMap = {};
            refOrders.forEach(o=>{
              const p=o.referralPerson||"Unknown";
              if(!personMap[p])personMap[p]={name:p,orders:0,amount:0,paid:0,channels:{}};
              personMap[p].orders++;
              personMap[p].amount+=num(o.referralAmount);
              if(o.referralPaid)personMap[p].paid+=num(o.referralAmount);
              const ch=o.channel||"Offline";
              personMap[p].channels[ch]=(personMap[p].channels[ch]||0)+1;
            });
            const persons=Object.values(personMap).sort((a,b)=>b.amount-a.amount);
            const chRefMap = {};
            refOrders.forEach(o=>{
              const ch=o.channel||"Offline";
              if(!chRefMap[ch])chRefMap[ch]={count:0,amount:0,paid:0};
              chRefMap[ch].count++;
              chRefMap[ch].amount+=num(o.referralAmount);
              if(o.referralPaid)chRefMap[ch].paid+=num(o.referralAmount);
            });
            const sortedTop3 = [...persons].sort((a,b)=>{
              if(refSort==="pending") return (b.amount-b.paid)-(a.amount-a.paid);
              if(refSort==="orders") return b.orders-a.orders;
              if(refSort==="value") return b.amount-a.amount;
              return 0;
            }).slice(0,3);
            const MEDALS = ["🥇","🥈","🥉"];
            return (<>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <KPITile label="Referred Orders" value={refOrders.length} sub={`of ${orders.length} total`} accent="#8b5cf6" icon="🤝"/>
                <KPITile label="Total Referral Due" value={fmtK(totalRefAmt)} sub="across all referrals" accent="#6366f1" icon="💰"/>
                <KPITile label="Paid Out" value={fmtK(paidRefAmt)} sub={`${paidRefs.length} paid`} accent="#10b981" icon="✅"/>
                <KPITile label="Pending Payout" value={fmtK(unpaidRefAmt)} sub={`${unpaidRefs.length} unpaid`} accent="#f43f5e" icon="⏰"/>
              </div>

              {sortedTop3.length>0&&<Card>
                <div className="flex items-center justify-between mb-2">
                  <Sec icon="🏆" title="Top 3 Referrers"/>
                  <select value={refSort} onChange={e=>setRefSort(e.target.value)}
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400">
                    <option value="pending">By Pending</option>
                    <option value="orders">By Orders</option>
                    <option value="value">By Total Value</option>
                  </select>
                </div>
                <div className="space-y-2 mt-1">
                  {sortedTop3.map((p,i)=>{
                    const pending = p.amount - p.paid;
                    const pct = p.amount>0?Math.round(p.paid/p.amount*100):0;
                    return (
                      <div key={p.name} className="flex items-center gap-3 py-2 border-b border-gray-200 last:border-0">
                        <span className="text-xl shrink-0 w-7 text-center">{MEDALS[i]}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-bold text-slate-700 truncate">{p.name}</span>
                            <span className="text-[10px] text-gray-400 shrink-0">{p.orders} order{p.orders!==1?"s":""}</span>
                          </div>
                          <div className="relative h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-400" style={{width:`${pct}%`}}/>
                            {pending>0&&<div className="absolute inset-y-0 rounded-full bg-orange-300" style={{left:`${pct}%`,right:"0"}}/>}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-xs font-black text-indigo-600">{fmtK(p.amount)} total</p>
                          {pending>0
                            ?<p className="text-[10px] font-bold text-orange-500">₹{Number(pending).toLocaleString("en-IN")} pending</p>
                            :<p className="text-[10px] font-bold text-emerald-500">✓ Fully paid</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>}

              {Object.keys(chRefMap).length>0&&<Card>
                <Sec icon="📍" title="Referrals by Channel"/>
                <div className="space-y-3">
                  {Object.entries(chRefMap).sort((a,b)=>b[1].amount-a[1].amount).map(([ch,{count,amount,paid}])=>(
                    <div key={ch} className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-gray-700 flex-1">{ch}</span>
                        <span className="text-[10px] text-gray-400">{count} orders</span>
                        <span className="text-xs font-bold text-indigo-600">{fmtK(amount)}</span>
                      </div>
                      <div className="relative h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-400" style={{width:`${amount?Math.round(paid/amount*100):0}%`}}/>
                        {amount-paid>0&&<div className="absolute inset-y-0 rounded-full bg-orange-300" style={{left:`${amount?Math.round(paid/amount*100):0}%`,right:"0"}}/>}
                      </div>
                      <div className="flex justify-between text-[9px]">
                        <span className="text-emerald-600 font-semibold">✓ {fmtK(paid)} paid</span>
                        {amount-paid>0&&<span className="text-orange-500 font-semibold">⏰ {fmtK(amount-paid)} pending</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>}

              {unpaidRefs.length>0&&<Card>
                <Sec icon="⏰" title="Pending Payouts — Ordered by Amount"/>
                <div className="space-y-1.5">
                  {unpaidRefs.sort((a,b)=>num(b.referralAmount)-num(a.referralAmount)).map(o=>(
                    <div key={o.orderNo} className="flex items-center gap-3 py-1.5 border-b border-gray-200 last:border-0">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-gray-400 shrink-0">{o.orderNo}</span>
                          <span className="text-xs text-gray-700 truncate">{o.customerName}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[9px] px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded-full font-semibold">{o.referralPerson||"?"}</span>
                          <span className="text-[9px] text-gray-400">{o.channel||"Offline"}</span>
                          <span className="text-[9px] text-gray-400">{o.orderDate||""}</span>
                        </div>
                      </div>
                      <span className="text-sm font-black text-orange-500 shrink-0">₹{Number(o.referralAmount||0).toLocaleString("en-IN")}</span>
                    </div>
                  ))}
                </div>
              </Card>}
            </>);
          })()}
        </div>
      )}
    </div>
  );
}


// ─── Admin Panel ──────────────────────────────────────────────────────────────
function AdminPanel({ sbUrl="", sbKey="", accessToken="", toast=()=>{}, currentUser=null }) {
  if (!currentUser?.isAdmin) return <div className="text-center py-20 text-red-500 font-bold">Access denied.</div>;
  const authToken = accessToken || sbKey; // use JWT if available, fall back to anon
  const [adminTab, setAdminTab] = useState("users");
  const [users, setUsers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [logFilter, setLogFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [logPage, setLogPage] = useState(0);

  // New user form
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [editingUser, setEditingUser] = useState(null);

  const TAB_LABELS = {analytics:"Analytics",new:"New Order",orders:"Orders",clients:"Clients",expenses:"Expenses",income:"Income",dashboard:"Splitwise",inventory:"Inventory",products:"Products",assets:"Assets",salary:"Salary",download:"Download",settings:"Settings"};
  const ALL = ["analytics","new","orders","clients","expenses","income","dashboard","inventory","products","assets","salary","download","settings"];

  const headers = { "apikey":sbKey, "Authorization":`Bearer ${authToken}`, "Content-Type":"application/json", "Prefer":"return=representation" };
  const hMin = { "apikey":sbKey, "Authorization":`Bearer ${authToken}`, "Content-Type":"application/json", "Prefer":"return=minimal" };

  const fetchUsers = async () => {
    setLoading(true);
    const r = await fetch(`${sbUrl}/rest/v1/user_roles?select=user_id,email,is_admin,permissions,is_active&order=email.asc`, {headers}).catch(()=>({ok:false}));
    if (r.ok) { const d=await r.json(); setUsers((d||[]).map(u=>({...u,id:u.user_id,username:u.email?.split("@")[0]||u.email}))); }
    setLoading(false);
  };

  const fetchLogs = async () => {
    setLoading(true);
    const filter = logFilter ? `&username=ilike.*${encodeURIComponent(logFilter)}*` : "";
    const r = await fetch(`${sbUrl}/rest/v1/app_audit_log?select=*&order=ts.desc&limit=200${filter}`, {headers}).catch(()=>({ok:false}));
    if (r.ok) { const d=await r.json(); setLogs(d||[]); }
    const rs = await fetch(`${sbUrl}/rest/v1/app_sessions?select=*&order=login_at.desc&limit=100`, {headers}).catch(()=>({ok:false}));
    if (rs.ok) { const d=await rs.json(); setSessions(d||[]); }
    setLoading(false);
  };

  useEffect(()=>{ if(sbUrl&&sbKey){ fetchUsers(); fetchLogs(); } },[sbUrl,sbKey]);

  const saveUser = async () => {
    if (!editingUser) return;
    setLoading(true);
    const body = {permissions:editingUser.permissions, is_active:editingUser.is_active, is_admin:!!editingUser.is_admin};
    const r = await fetch(`${sbUrl}/rest/v1/user_roles?user_id=eq.${editingUser.id}`, {method:"PATCH",headers:hMin,body:JSON.stringify(body)});
    toast(r.ok?"Permissions saved":"Error saving permissions", r.ok?"success":"error");
    setEditingUser(null);
    fetchUsers(); setLoading(false);
  };

  const toggleActive = async (u) => {
    await fetch(`${sbUrl}/rest/v1/user_roles?user_id=eq.${u.id}`, {method:"PATCH",headers:hMin,body:JSON.stringify({is_active:!u.is_active})});
    fetchUsers();
  };

  const deleteUser = async (u) => {
    if (!window.confirm(`Remove permissions for "${u.username}"?\nThis removes their app access but keeps their Supabase Auth account.`)) return;
    await fetch(`${sbUrl}/rest/v1/user_roles?user_id=eq.${u.id}`, {method:"DELETE",headers:hMin});
    toast("User access removed"); fetchUsers();
  };

  const setPermission = (tabId, level) => {
    if (!editingUser) return;
    const subTabs = TAB_SUBTABS[tabId]||[];
    if (subTabs.length>0) {
      // Setting parent perm = set all sub-tabs to same level
      const subPerms = Object.fromEntries(subTabs.map(st=>[st,level]));
      setEditingUser(p=>({...p, permissions:{...p.permissions,[tabId]:level==="none"?"none":subPerms}}));
    } else {
      setEditingUser(p=>({...p, permissions:{...p.permissions,[tabId]:level}}));
    }
  };
  const setSubPermission = (tabId, subTabId, level) => {
    if (!editingUser) return;
    setEditingUser(p=>{
      const cur = p.permissions?.[tabId];
      const base = typeof cur==="object"&&cur!==null ? {...cur} : {};
      base[subTabId] = level;
      // If all none, set parent to none string
      const subTabs = TAB_SUBTABS[tabId]||[];
      const allNone = subTabs.every(st=>(base[st]||"none")==="none");
      return {...p, permissions:{...p.permissions,[tabId]:allNone?"none":base}};
    });
  };

  const PERM_LEVELS = ["none","read","write"];
  const PERM_COLORS = {none:"bg-gray-100 text-gray-400", read:"bg-blue-100 text-blue-700", write:"bg-emerald-100 text-emerald-700"};

  const filteredLogs = logFilter ? logs.filter(l=>l.username?.toLowerCase().includes(logFilter.toLowerCase())||l.action?.toLowerCase().includes(logFilter.toLowerCase())) : logs;
  const PAGE_SIZE = 25;
  const pagedLogs = filteredLogs.slice(logPage*PAGE_SIZE, (logPage+1)*PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div><h2 className="font-bold text-lg text-slate-800">🛡️ Admin Panel</h2>
          <p className="text-xs text-gray-400">Manage users, permissions and audit logs</p>
        </div>
        <button onClick={()=>{fetchUsers();fetchLogs();}} className="text-xs border border-gray-200 text-gray-500 hover:bg-gray-50 px-3 py-1.5 rounded-lg">⟳ Refresh</button>
      </div>

      {/* Sub tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
        {[["users","👤 Users & Permissions"],["logs","📋 Audit Logs"],["sessions","🔐 Sessions"]].map(([id,lb])=>(
          <button key={id} onClick={()=>setAdminTab(id)}
            className={"flex-1 py-2 rounded-lg text-xs font-semibold transition-all "+(adminTab===id?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700")}>
            {lb}
          </button>
        ))}
      </div>

      {/* ── USERS ──────────────────────────────────────────────────────────── */}
      {adminTab==="users"&&(
        <div className="space-y-4">
          {/* User list */}
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-gray-100 flex items-center justify-between">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">{users.filter(u=>!u.is_admin).length} Users</p>
            </div>
            {loading?<p className="text-xs text-gray-400 text-center py-6">Loading…</p>:(
              <div className="divide-y divide-gray-200">
                {users.filter(u=>!u.is_admin).map(u=>(
                  <div key={u.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
                    <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-black text-xs shrink-0">{u.username[0]?.toUpperCase()}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-700">{u.username}</p>
                      <p className="text-[10px] text-gray-400">{Object.values(u.permissions||{}).filter(v=>v!=="none").length} tabs accessible</p>
                    </div>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${u.is_active?"bg-emerald-100 text-emerald-700":"bg-red-100 text-red-500"}`}>{u.is_active?"Active":"Inactive"}</span>
                    <button onClick={()=>{setEditingUser({...u});setNewUsername(u.username);setNewPassword("");}} className="text-xs text-indigo-600 border border-indigo-200 hover:bg-indigo-50 px-2 py-1 rounded-lg">Edit</button>
                    <button onClick={()=>toggleActive(u)} className="text-xs text-gray-500 border border-gray-200 hover:bg-gray-50 px-2 py-1 rounded-lg">{u.is_active?"Deactivate":"Activate"}</button>
                    <button onClick={()=>deleteUser(u)} className="text-xs text-red-500 border border-red-200 hover:bg-red-50 px-2 py-1 rounded-lg">Delete</button>
                  </div>
                ))}
                {users.length===0&&<p className="text-xs text-gray-400 text-center py-8">No users yet. Create one above.</p>}
              </div>
            )}
          </div>

          {/* Edit/Create form */}
          {editingUser!==null&&(
            <div className="bg-white border border-indigo-200 rounded-2xl shadow-sm p-5 space-y-4">
              <p className="text-sm font-bold text-slate-700">{editingUser.id?"Edit User: "+editingUser.username:"Create New User"}</p>
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-700">
                <strong>Editing:</strong> {editingUser.email} — Passwords are managed in Supabase Auth dashboard. Here you only set tab permissions.
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!editingUser.is_admin} onChange={e=>setEditingUser(p=>({...p,is_admin:e.target.checked}))} className="rounded"/>
                  <span className="text-xs font-semibold text-indigo-700">Admin (full access)</span>
                </label>
              </div>

              {/* Permissions grid */}
              <div>
                <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">Tab Permissions</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {ALL.filter(t=>t!=="admin").map(tabId=>{
                    const pVal = editingUser.permissions?.[tabId];
                    const subTabs = TAB_SUBTABS[tabId]||[];
                    // For display: if subTabs exist, derive parent state from sub-tab values
                    const getSubPerm = (st) => typeof pVal==="object"&&pVal!==null ? (pVal[st]||"none") : (typeof pVal==="string"?pVal:"none");
                    const parentCur = subTabs.length===0
                      ? (typeof pVal==="string"?pVal:"none")
                      : (subTabs.every(st=>getSubPerm(st)==="none")?"none":subTabs.every(st=>getSubPerm(st)==="write")?"write":"read");
                    return (
                      <div key={tabId} className="bg-gray-50 rounded-xl px-3 py-2 space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-700 font-bold flex-1">{TAB_LABELS[tabId]||tabId}</span>
                          {subTabs.length===0&&<div className="flex gap-1">
                            {PERM_LEVELS.map(lvl=>(
                              <button key={lvl} onClick={()=>setPermission(tabId,lvl)}
                                className={"text-[10px] font-bold px-2 py-0.5 rounded-full transition-all "+(parentCur===lvl?PERM_COLORS[lvl]:"bg-white border border-gray-200 text-gray-400 hover:border-gray-300")}>
                                {lvl==="none"?"✗":lvl==="read"?"R":"R+W"}
                              </button>
                            ))}
                          </div>}
                          {subTabs.length>0&&<span className={"text-[9px] px-1.5 py-0.5 rounded-full font-bold "+(parentCur==="none"?"bg-red-100 text-red-400":parentCur==="write"?"bg-emerald-100 text-emerald-700":"bg-blue-100 text-blue-700")}>{parentCur==="none"?"No access":parentCur==="write"?"Full access":"Partial"}</span>}
                        </div>
                        {subTabs.length>0&&(
                          <div className="ml-2 space-y-1 border-l-2 border-indigo-100 pl-2">
                            {subTabs.map(st=>{
                              const stVal = getSubPerm(st);
                              return (
                                <div key={st} className="flex items-center gap-2">
                                  <span className="text-[10px] text-gray-600 flex-1 capitalize">{st}</span>
                                  <div className="flex gap-0.5">
                                    {PERM_LEVELS.map(lvl=>(
                                      <button key={lvl} onClick={()=>setSubPermission(tabId,st,lvl)}
                                        className={"text-[9px] font-bold px-1.5 py-0.5 rounded-full transition-all "+(stVal===lvl?PERM_COLORS[lvl]:"bg-white border border-gray-200 text-gray-400 hover:border-gray-300")}>
                                        {lvl==="none"?"✗":lvl==="read"?"R":"R+W"}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2 mt-2">
                  <button onClick={()=>setEditingUser(p=>({...p,permissions:Object.fromEntries(ALL.filter(t=>t!=="admin").map(t=>{const st=TAB_SUBTABS[t]||[];return [t,st.length?Object.fromEntries(st.map(s=>[s,"write"])):"write"];}))}))} className="text-xs text-emerald-600 border border-emerald-200 hover:bg-emerald-50 px-2 py-1 rounded-lg">Grant All</button>
                  <button onClick={()=>setEditingUser(p=>({...p,permissions:Object.fromEntries(ALL.filter(t=>t!=="admin").map(t=>{const st=TAB_SUBTABS[t]||[];return [t,st.length?Object.fromEntries(st.map(s=>[s,"read"])):"read"];}))}))} className="text-xs text-blue-600 border border-blue-200 hover:bg-blue-50 px-2 py-1 rounded-lg">Read All</button>
                  <button onClick={()=>setEditingUser(p=>({...p,permissions:Object.fromEntries(ALL.filter(t=>t!=="admin").map(t=>[t,"none"]))}))} className="text-xs text-red-500 border border-red-200 hover:bg-red-50 px-2 py-1 rounded-lg">Revoke All</button>
                </div>
              </div>

              <div className="flex gap-2 pt-2 border-t border-gray-100">
                <button onClick={saveUser} disabled={loading} className="flex-1 py-2 rounded-xl font-bold text-sm bg-indigo-600 hover:bg-indigo-700 text-white transition-all">
                  {loading?"Saving…":editingUser.id?"Save Changes":"Create User"}
                </button>
                <button onClick={()=>{setEditingUser(null);setNewUsername("");setNewPassword("");}} className="px-4 py-2 rounded-xl text-sm border border-gray-200 text-gray-500 hover:bg-gray-50">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── AUDIT LOGS ─────────────────────────────────────────────────────── */}
      {adminTab==="logs"&&(
        <div className="space-y-3">
          <div className="flex gap-2">
            <input value={logFilter} onChange={e=>{setLogFilter(e.target.value);setLogPage(0);}} placeholder="Filter by user or action…"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
            <button onClick={fetchLogs} className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-3 py-2 rounded-lg text-xs">⟳</button>
          </div>
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="p-3 border-b border-gray-100 flex items-center justify-between">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">{filteredLogs.length} events</p>
              <div className="flex gap-1">
                <button disabled={logPage===0} onClick={()=>setLogPage(p=>p-1)} className="text-xs border border-gray-200 px-2 py-1 rounded-lg disabled:opacity-40">◀</button>
                <span className="text-xs text-gray-400 px-2 py-1">{logPage+1}/{Math.max(1,Math.ceil(filteredLogs.length/PAGE_SIZE))}</span>
                <button disabled={(logPage+1)*PAGE_SIZE>=filteredLogs.length} onClick={()=>setLogPage(p=>p+1)} className="text-xs border border-gray-200 px-2 py-1 rounded-lg disabled:opacity-40">▶</button>
              </div>
            </div>
            {loading?<p className="text-xs text-gray-400 text-center py-6">Loading…</p>:(
              <div className="divide-y divide-gray-200 max-h-[60vh] overflow-y-auto">
                {pagedLogs.map(l=>(
                  <div key={l.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-gray-50">
                    <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-black text-[9px] shrink-0 mt-0.5">{l.username?.[0]?.toUpperCase()}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-bold text-slate-700">{l.username}</span>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${l.action?.includes("delete")?"bg-red-100 text-red-600":l.action?.includes("upsert")||l.action?.includes("write")?"bg-amber-100 text-amber-700":"bg-gray-100 text-gray-500"}`}>{l.action}</span>
                        {l.tab&&<span className="text-[9px] text-gray-400">{l.tab}</span>}
                      </div>
                      {l.detail&&<p className="text-[10px] text-gray-400 truncate mt-0.5">{l.detail}</p>}
                    </div>
                    <span className="text-[9px] text-gray-300 shrink-0">{l.ts?new Date(l.ts).toLocaleString("en-IN",{dateStyle:"short",timeStyle:"short"}):""}</span>
                  </div>
                ))}
                {pagedLogs.length===0&&<p className="text-xs text-gray-400 text-center py-8">No logs found.</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── SESSIONS ───────────────────────────────────────────────────────── */}
      {adminTab==="sessions"&&(
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-3 border-b border-gray-100 flex items-center gap-2">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest flex-1">{sessions.length} Recent Sessions</p>
            <input value={sessionFilter} onChange={e=>setSessionFilter(e.target.value)} placeholder="Filter by user…"
              className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400 w-36"/>
          </div>
          <div className="divide-y divide-gray-200 max-h-[60vh] overflow-y-auto">
            {sessions.filter(s=>!sessionFilter||s.username?.toLowerCase().includes(sessionFilter.toLowerCase())).map(s=>(
              <div key={s.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
                <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-black text-[9px] shrink-0">{s.username?.[0]?.toUpperCase()}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-700">{s.username}</p>
                  <p className="text-[10px] text-gray-400">Login: {s.login_at?new Date(s.login_at).toLocaleString("en-IN",{dateStyle:"short",timeStyle:"short"}):""}</p>
                </div>
                <div className="text-right">
                  {s.logout_at
                    ?<span className="text-[9px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full">Logged out {new Date(s.logout_at).toLocaleString("en-IN",{timeStyle:"short"})}</span>
                    :<span className="text-[9px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded-full font-bold">● Active</span>
                  }
                </div>
              </div>
            ))}
            {sessions.length===0&&<p className="text-xs text-gray-400 text-center py-8">No sessions recorded.</p>}
          </div>
        </div>
      )}
    </div>
  );
}


function SalaryManager({ employees=[], setEmployees, expenses=[], setExpenses, upsertEmployee=()=>{}, deleteEmployee=()=>{}, deleteExpense=()=>{}, toast=()=>{}, readOnly=false }) {
  const [subTab, setSubTab] = useState("records");
  const [showEmpForm, setShowEmpForm] = useState(false);
  const [empForm, setEmpForm] = useState({name:"", role:""});
  const [editEmpId, setEditEmpId] = useState(null);

  const [salForm, setSalForm] = useState({employeeId:"", amount:"", date:today(), notes:""});
  const [showSalForm, setShowSalForm] = useState(false);

  const salaryExpenses = expenses.filter(e=>e.category==="Salary"&&!e.isDeleted);

  const handleSaveEmployee = () => {
    if (!empForm.name.trim()) { toast("Name is required","error"); return; }
    const id = editEmpId || ("EMP-"+Date.now());
    const emp = {id, name:empForm.name.trim(), role:empForm.role.trim(), isDeleted:false};
    if (editEmpId) {
      setEmployees(prev=>prev.map(e=>e.id===editEmpId?emp:e));
    } else {
      setEmployees(prev=>[...prev,emp]);
    }
    upsertEmployee(emp);
    setEmpForm({name:"",role:""}); setEditEmpId(null); setShowEmpForm(false);
    toast(editEmpId?"Employee updated":"Employee added");
  };

  const handleDeleteEmployee = (emp) => {
    if (!window.confirm(`Remove ${emp.name}?`)) return;
    setEmployees(prev=>prev.filter(e=>e.id!==emp.id));
    deleteEmployee(emp);
    toast("Employee removed");
  };

  const handleSaveSalary = () => {
    if (!salForm.employeeId) { toast("Select an employee","error"); return; }
    if (!salForm.amount || isNaN(Number(salForm.amount)) || Number(salForm.amount)<=0) { toast("Enter a valid amount","error"); return; }
    if (!salForm.date) { toast("Enter a date","error"); return; }
    const emp = employees.find(e=>e.id===salForm.employeeId);
    const id = "SAL-"+Date.now();
    const expense = {
      id, date:salForm.date, paidBy:"__company__",
      amount:Number(salForm.amount),
      category:"Salary",
      comment:`${emp?.name||"Employee"}${salForm.notes?" — "+salForm.notes:""}`,
      isDeleted:false,
    };
    setExpenses(prev=>[...prev, expense]);
    setSalForm({employeeId:"", amount:"", date:today(), notes:""});
    setShowSalForm(false);
    toast("Salary recorded");
  };

  const handleDeleteSalary = (exp) => {
    if (!window.confirm("Delete this salary record?")) return;
    setExpenses(prev=>prev.filter(e=>e.id!==exp.id));
    deleteExpense({...exp, isDeleted:true});
    toast("Salary record deleted");
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-bold text-slate-700">Salary & Stipend</p>
        <p className="text-xs text-gray-400">Manage employees/interns and log salary payments. All payments are recorded as company expenses.</p>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-2 border-b border-gray-100 pb-0">
        {[["records","💰 Salary Records"],["employees","👤 Employees"]].map(([id,label])=>(
          <button key={id} onClick={()=>setSubTab(id)}
            className={`px-4 py-2 text-xs font-semibold rounded-t-lg border border-b-0 transition-all ${subTab===id?"bg-white border-gray-200 text-indigo-600":"bg-transparent border-transparent text-gray-400 hover:text-gray-600"}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Employees sub-tab */}
      {subTab==="employees"&&(
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{employees.length} employee{employees.length!==1?"s":""}</p>
            {!readOnly&&<button onClick={()=>{setShowEmpForm(true);setEditEmpId(null);setEmpForm({name:"",role:""}); }}
              className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg font-semibold">+ Add</button>}
          </div>
          {showEmpForm&&(
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 space-y-3">
              <p className="text-xs font-bold text-indigo-700 uppercase tracking-wide">{editEmpId?"Edit":"New"} Employee</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <F label="Name" value={empForm.name} onChange={v=>setEmpForm(f=>({...f,name:v}))} placeholder="Full name"/>
                <F label="Role" value={empForm.role} onChange={v=>setEmpForm(f=>({...f,role:v}))} placeholder="e.g. Intern, Designer"/>
              </div>
              <div className="flex gap-2">
                <button onClick={handleSaveEmployee} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg text-xs font-semibold">Save</button>
                <button onClick={()=>{setShowEmpForm(false);setEditEmpId(null);}} className="border border-gray-200 text-gray-500 px-4 py-1.5 rounded-lg text-xs">Cancel</button>
              </div>
            </div>
          )}
          {employees.length===0&&!showEmpForm&&<p className="text-xs text-gray-400 text-center py-8">No employees added yet.</p>}
          <div className="space-y-2">
            {employees.map(emp=>(
              <div key={emp.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">{emp.name}</p>
                  {emp.role&&<p className="text-xs text-gray-400">{emp.role}</p>}
                </div>
                <div className="flex gap-2">
                  {!readOnly&&<button onClick={()=>{setEditEmpId(emp.id);setEmpForm({name:emp.name,role:emp.role||""});setShowEmpForm(true);}}
                    className="text-xs border border-gray-200 text-gray-500 hover:bg-gray-50 px-3 py-1.5 rounded-lg">Edit</button>}
                  {!readOnly&&<button onClick={()=>handleDeleteEmployee(emp)}
                    className="text-xs border border-red-200 text-red-500 hover:bg-red-50 px-3 py-1.5 rounded-lg">Remove</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Salary Records sub-tab */}
      {subTab==="records"&&(
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{salaryExpenses.length} record{salaryExpenses.length!==1?"s":""}</p>
              {salaryExpenses.length>0&&<p className="text-xs text-gray-400 mt-0.5">Total paid: <span className="font-semibold text-slate-700">₹{salaryExpenses.reduce((s,e)=>s+Number(e.amount||0),0).toLocaleString("en-IN")}</span></p>}
            </div>
            {!readOnly&&<button onClick={()=>setShowSalForm(v=>!v)}
              className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg font-semibold">+ Record Payment</button>}
          </div>

          {showSalForm&&(
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 space-y-3">
              <p className="text-xs font-bold text-indigo-700 uppercase tracking-wide">Record Salary / Stipend</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1 col-span-2">
                  <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Employee / Intern</label>
                  <select value={salForm.employeeId} onChange={e=>setSalForm(f=>({...f,employeeId:e.target.value}))}
                    className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                    <option value="">— Select —</option>
                    {employees.map(e=><option key={e.id} value={e.id}>{e.name}{e.role?` (${e.role})`:""}</option>)}
                  </select>
                </div>
                <F label="Amount (₹)" type="number" value={salForm.amount} onChange={v=>setSalForm(f=>({...f,amount:v}))} placeholder="0.00"/>
                <F label="Date" type="date" value={salForm.date} onChange={v=>setSalForm(f=>({...f,date:v}))}/>
                <F label="Notes (optional)" value={salForm.notes} onChange={v=>setSalForm(f=>({...f,notes:v}))} placeholder="e.g. March salary, bonus…" className="col-span-2"/>
              </div>
              <div className="flex gap-2">
                <button onClick={handleSaveSalary} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg text-xs font-semibold">Save</button>
                <button onClick={()=>setShowSalForm(false)} className="border border-gray-200 text-gray-500 px-4 py-1.5 rounded-lg text-xs">Cancel</button>
              </div>
            </div>
          )}

          {salaryExpenses.length===0&&!showSalForm&&<p className="text-xs text-gray-400 text-center py-8">No salary records yet.</p>}
          <div className="space-y-2">
            {salaryExpenses.slice().reverse().map(e=>(
              <div key={e.id} className="flex items-start justify-between bg-white border border-gray-200 rounded-xl px-4 py-3 gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-slate-800">₹{Number(e.amount).toLocaleString("en-IN",{minimumFractionDigits:2})}</span>
                    <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-semibold">Salary</span>
                    <span className="text-xs text-gray-400">{e.date}</span>
                  </div>
                  {e.comment&&<p className="text-xs text-gray-500 mt-0.5">{e.comment}</p>}
                </div>
                {!readOnly&&<button onClick={()=>handleDeleteSalary(e)} className="text-red-300 hover:text-red-500 font-bold text-lg leading-none shrink-0">×</button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ExpenseTracker({ expenses, setExpenses, recipients, allRecipients=[], seller, deleteExpense=()=>{}, toast=()=>{}, readOnly=false, subTabPerms=null }) {
  const canExpTab = (id) => !subTabPerms || subTabPerms[id]==="read"||subTabPerms[id]==="write";
  const firstExpTab = ["expenses","categories"].find(t=>canExpTab(t)) || "expenses";
  const [form, setForm] = useState({...EMPTY_EXPENSE, date:today()});
  const [editId, setEditId] = useState(null);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("All");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [msg, setMsg] = useState("");
  const [expTab, setExpTab] = useState(firstExpTab);
  const [cats, setCats] = useState(()=>{ try{const s=localStorage.getItem("expense_cats");return s?JSON.parse(s):DEFAULT_EXPENSE_CATS;}catch(e){return DEFAULT_EXPENSE_CATS;} });
  const [newCat, setNewCat] = useState("");
  const saveCats = (u) => { setCats(u); try{localStorage.setItem("expense_cats",JSON.stringify(u));}catch(e){} };
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
    .slice().sort((a,b)=>b.date.localeCompare(a.date)||String(b.id).localeCompare(String(a.id)));

  const total = filtered.reduce((s,e)=>s+num(e.amount),0);
  const grandTotal = expenses.reduce((s,e)=>s+num(e.amount),0);

  return (
    <div className="space-y-4">
      {/* Sub-tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 overflow-x-auto scrollbar-none w-fit max-w-full">
        {[["expenses","Expenses"],["categories","Categories"]].filter(([id])=>canExpTab(id)).map(([id,label])=>(
          <button key={id} onClick={()=>setExpTab(id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${expTab===id?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700"}`}>{label}</button>
        ))}
      </div>

      {expTab==="categories"&&canExpTab("categories")&&(
        <div className="space-y-3">
          <p className="text-xs text-gray-400">Manage expense categories. Default categories cannot be removed.</p>
          <div className="flex gap-2">
            <input value={newCat} onChange={e=>setNewCat(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&newCat.trim()){saveCats([...cats,newCat.trim()]);setNewCat("");}}}
              placeholder="New category name…"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
            {!readOnly&&<button onClick={()=>{if(newCat.trim()){saveCats([...cats,newCat.trim()]);setNewCat("");}}}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">+ Add</button>}
          </div>
          <div className="space-y-1">
            {cats.map(c=>(
              <div key={c} className="flex items-center justify-between bg-white border border-gray-100 rounded-lg px-3 py-2">
                <span className="text-sm text-gray-700">{c}</span>
                {!DEFAULT_EXPENSE_CATS.includes(c)&&<button onClick={()=>saveCats(cats.filter(x=>x!==c))} className="text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {expTab==="expenses"&&canExpTab("expenses")&&<>
      {/* Form */}
      {!readOnly&&<div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-3">
        <h3 className="font-bold text-gray-800 text-sm">{editId?"Edit Expense":"Record Expense"}</h3>
        {msg&&<p className="text-xs text-indigo-600 font-semibold">{msg}</p>}
        <div className="flex flex-col gap-3">
          <F label="Date" type="date" value={form.date} onChange={v=>upd("date",v)} required/>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Paid By <span className="text-red-400">*</span></label>
            <select value={form.paidBy} onChange={e=>upd("paidBy",e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
              <option value="">— Select recipient —</option>
              <option value="__company__">{seller?.name||"Company"}</option>{recipients.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <F label="Amount (₹)" type="number" value={form.amount} onChange={v=>upd("amount",v)} placeholder="0.00" required/>
          <S label="Category" value={form.category} onChange={v=>upd("category",v)} options={cats}/>
          <F label="Comment (optional)" value={form.comment} onChange={v=>upd("comment",v)} placeholder="Any notes…"/>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={handleSave} className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-semibold">{editId?"Save Changes":"Add Expense"}</button>
          {editId&&<button onClick={handleCancel} className="border border-gray-200 text-gray-500 hover:bg-gray-50 px-4 py-2 rounded-lg text-sm">Cancel</button>}
        </div>
      </div>}

      {/* Summary strip */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
            {["All",...cats].map(c=>(
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
            <div key={e.id} className="border border-gray-200 rounded-xl px-4 py-3 bg-white flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-red-600">₹{fmt(e.amount)}</span>
                  <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">{e.category}</span>
                  <span className="text-xs text-gray-400">{e.date}</span>
                </div>
                {rcp&&<p className="text-xs text-indigo-500 mt-0.5">👤 {rcp.name}</p>}
                {e.comment&&<p className="text-xs text-gray-500 mt-0.5">{e.comment}</p>}
              </div>
              <div className="flex gap-1.5 shrink-0 flex-wrap">
                {!readOnly&&<button onClick={()=>handleEdit(e)} className="text-xs border border-gray-200 text-gray-600 hover:bg-gray-50 px-2.5 py-1.5 rounded-lg">✏️</button>}
                <button onClick={()=>handleDelete(e.id)} className="text-xs border border-red-100 text-red-400 hover:bg-red-50 px-2.5 py-1.5 rounded-lg">×</button>
              </div>
            </div>
          );
        })}
      </div>
      </>}
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

function AssetManager({ assets=[], setAssets, deleteAsset=()=>{}, expenses=[], setExpenses, recipients=[], allRecipients=[], seller, cdnCloud="", cdnPreset="", toast=()=>{}, readOnly=false }) {
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
          {!readOnly&&<button onClick={()=>{ setForm({...EMPTY_ASSET,purchaseDate:today()}); setEditId(null); setShowForm(v=>!v); }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-semibold">
            {showForm ? "Close Form" : "+ Add Asset"}
          </button>}
        </div>
      </div>

      {/* Form */}
      {showForm && !readOnly && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-4">
          <h3 className="font-bold text-slate-700 text-sm">{editId ? "Edit Asset — "+editId : "New Asset"}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
              <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3">
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
          <div key={a.id} className="bg-white border border-gray-200 rounded-xl px-4 py-4 hover:shadow-md transition-all border-l-4 border-l-indigo-100">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-slate-800">{a.name}</span>
                  <span className="text-xs font-mono bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">{a.id}</span>
                  <span className="text-xs bg-indigo-50 text-indigo-700 font-semibold border border-indigo-100 px-2 py-0.5 rounded-full">{a.category}</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-0 mt-3 border border-gray-100 rounded-lg overflow-hidden">
                  {[
                    ["Date", a.purchaseDate||"—", "text-gray-700"],
                    ["Amount", a.amount>0?`₹${fmt(num(a.amount))}`:"—", "text-emerald-700 font-bold"],
                    ["Paid By", resolveName(a.paidBy)||"—", "text-gray-700"],
                    ["Vendor", a.vendor||"—", "text-gray-700"],
                  ].map(([lbl,val,cls],i)=>(
                    <div key={i} className={`px-3 py-2.5 text-center ${i===0?"border-r border-gray-100":i===1?"md:border-r border-gray-100":i===2?"border-r md:border-r border-gray-100 border-t md:border-t-0":""}`}>
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
                {!readOnly&&<button onClick={()=>handleEdit(a)} className="text-xs border border-gray-200 text-gray-600 hover:bg-gray-50 px-3 py-1.5 rounded-lg font-medium">Edit</button>}
                {!readOnly&&<button onClick={()=>handleDelete(a)} className="text-xs border border-red-200 text-red-500 hover:bg-red-50 px-3 py-1.5 rounded-lg font-medium">Delete</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Income View ──────────────────────────────────────────────────────────────
function IncomeView({ orders, quotations=[], taxInvoices=[], recipients, allRecipients=[], seller, subTabPerms=null }) {
  const canIncTab = (id) => !subTabPerms || subTabPerms[id]==="read"||subTabPerms[id]==="write";
  const firstIncTab = ["payments","invoiced"].find(t=>canIncTab(t)) || "payments";
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [recipientFilter, setRecipientFilter] = useState("");
  const [modeFilter, setModeFilter] = useState("All");
  const [view, setView] = useState(firstIncTab);
  const [statusFilter, setStatusFilter] = useState("All");
  const [incChannelFilter, setIncChannelFilter] = useState("All");

  const resolveName = (id) => {
    if (!id) return "";
    if (id === "__company__") return seller?.name || "Company";
    const r = recipients.find(r => r.id === id) || allRecipients.find(r => r.id === id);
    return r ? r.name : "";
  };

  // Gather all payments: advance + payment entries
  const allPayments = [];
  orders.forEach(o => {
    // Advance excluded from cancelled orders (likely to be refunded)
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
        amount: p.isRefund ? -num(p.amount) : num(p.amount),
        mode: p.mode||"", receivedBy: resolveName(p.receivedBy),
        txnRef: p.txnRef||"", note: p.isRefund?`Refund to ${p.refundTo||o.customerName}`:(p.comments||"Payment"),
        type: o.type||"", isRefund: !!p.isRefund
      });
    });
  });

  // Build invoiced orders list (orders that have a tax invoice)
  const invoicedOrders = orders.map(o => {
    const tis = taxInvoices.filter(t=>t.orderId===o.orderNo);
    const qt = quotations.find(q=>q.orderId===o.orderNo);
    // Income: items only, no charges
    const rawInvoicedAmt = tis.length
      ? tis.reduce((s,t)=>s+(t.items?.reduce((a,i)=>a+num(i.netAmt),0)||0),0)
      : (qt ? num(qt.amount) : (o.items||[]).reduce((s,i)=>s+num(i.netAmt),0));
    // For cancelled orders show net collected instead of invoice amount
    const invoicedAmt = o.status==="Cancelled"
      ? Math.max(0, (o.payments||[]).reduce((s,p)=>s+(p.isRefund?-num(p.amount):num(p.amount)),0) + num(o.advance))
      : rawInvoicedAmt;
    const paidAmt = (o.payments||[]).reduce((s,p)=>s+(p.isRefund?-num(p.amount):num(p.amount)),0) + num(o.advance);
    const balance = o.status==="Cancelled" ? 0 : invoicedAmt - paidAmt;
    const invNos = tis.length ? tis.map(t=>t.invNo).join(", ") : (qt ? qt.invNo : "");
    const docType = tis.length ? "Tax Invoice" : qt ? "Quotation" : "Order";
    return { orderNo:o.orderNo, customerName:o.customerName, type:o.type, orderDate:o.orderDate, invoicedAmt, paidAmt, balance, status:o.status, invNos, docType };
  });

  const filteredInvoiced = invoicedOrders
    .filter(o => !fromDate || o.orderDate >= fromDate)
    .filter(o => !toDate || o.orderDate <= toDate)
    .filter(o => typeFilter === "All" || o.type === typeFilter)
    .filter(o => statusFilter === "All" || o.status === statusFilter)
    .filter(o => incChannelFilter === "All" || (incChannelFilter==="Offline"?(o.channel||"Offline")==="Offline":(o.channel||"Offline")!=="Offline"&&(incChannelFilter==="Online"||o.channel===incChannelFilter)))
    .filter(o => {
      if (!search) return true;
      const s = search.toLowerCase();
      return o.orderNo.toLowerCase().includes(s) || o.customerName.toLowerCase().includes(s) || (o.invNos||"").toLowerCase().includes(s);
    })
    .sort((a,b) => b.orderDate.localeCompare(a.orderDate));

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
      {/* View toggle */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 overflow-x-auto scrollbar-none w-fit max-w-full">
        {[["payments","Payments"],["invoiced","All Orders"]].filter(([v])=>canIncTab(v)).map(([v,l])=>(
          <button key={v} onClick={()=>setView(v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${view===v?"bg-white text-indigo-700 shadow-sm":"text-gray-500"}`}>{l}</button>
        ))}
      </div>

      <div className="space-y-3">
        <input value={search} onChange={e=>setSearch(e.target.value)}
          placeholder={view==="payments"?"Search by order no, customer, recipient, txn ref…":"Search by order no, customer, invoice no…"}
          className="border border-gray-200 rounded-lg px-4 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-xs font-semibold text-gray-400">From</span>
            <input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
            <span className="text-xs font-semibold text-gray-400">To</span>
            <input type="date" value={toDate} onChange={e=>setToDate(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
          <div className="flex gap-1 shrink-0">
            {["All","B2B","B2C"].map(t=><button key={t} onClick={()=>setTypeFilter(t)} className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${typeFilter===t?"bg-indigo-600 border-indigo-600 text-white":"border-gray-200 text-gray-500 hover:border-indigo-300"}`}>{t}</button>)}
          </div>
          <select value={recipientFilter} onChange={e=>setRecipientFilter(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
            <option value="">All Recipients</option>
            {allPayRecipients.map(r=><option key={r} value={r}>{r}</option>)}
          </select>
          <select value={modeFilter} onChange={e=>setModeFilter(e.target.value)} className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
            {allModes.map(m=><option key={m} value={m}>{m==="All"?"All Modes":m}</option>)}
          </select>
          {(fromDate||toDate||typeFilter!=="All"||recipientFilter||modeFilter!=="All")&&(
            <button onClick={()=>{setFromDate("");setToDate("");setTypeFilter("All");setRecipientFilter("");setModeFilter("All");}} className="text-xs text-indigo-500 hover:underline shrink-0">Clear</button>
          )}
        </div>
      </div>

      {view==="payments"&&canIncTab("payments")&&<>
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
            <div key={i} className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between gap-4 hover:shadow-sm transition-all">
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
              <span className={`font-bold text-base shrink-0 ${p.isRefund?"text-red-500":"text-emerald-600"}`}>{p.isRefund?"−":"+"}&#x20B9;{Math.abs(num(p.amount)).toLocaleString("en-IN",{minimumFractionDigits:2})}</span>
            </div>
          ))}
        </div>
      )}
      </>}

      {view==="invoiced"&&canIncTab("invoiced")&&(
        <div className="space-y-3">
          <div className="flex overflow-x-auto scrollbar-none gap-1.5 mb-1 pb-0.5">
            {["All","Pending","Completed","Cancelled"].map(s=>(
              <button key={s} onClick={()=>setStatusFilter(s)}
                className={`shrink-0 px-3 py-1 rounded-full text-xs font-semibold border transition-all ${statusFilter===s?"bg-slate-700 border-slate-700 text-white":"border-gray-200 text-gray-500"}`}>{s}</button>
            ))}
          </div>
          <div className="flex overflow-x-auto scrollbar-none gap-1.5 mb-1 pb-0.5">
            {["All","Offline","Online",...ONLINE_PLATFORMS].map(c=>(
              <button key={c} onClick={()=>setIncChannelFilter(c)}
                className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-semibold border transition-all ${incChannelFilter===c?"bg-sky-600 border-sky-600 text-white":"border-gray-200 text-gray-500"}`}>{c==="Offline"?"🏪 Offline":c==="Online"?"🌐 Online":c==="All"?"All":c}</button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              ["Order Value", filteredInvoiced.reduce((s,o)=>s+o.invoicedAmt,0), "from-indigo-600 to-violet-600"],
              ["Collected", filteredInvoiced.reduce((s,o)=>s+o.paidAmt,0), "from-emerald-500 to-teal-500"],
              ["Outstanding", filteredInvoiced.filter(o=>o.status!=="Cancelled").reduce((s,o)=>s+Math.max(0,o.balance),0), "from-orange-500 to-amber-500"],
            ].map(([label,amt,grad])=>(
              <div key={label} className={`bg-gradient-to-r ${grad} rounded-xl p-4 text-white`}>
                <p className="text-[10px] opacity-80 leading-tight">{label}</p>
                <p className="text-base md:text-xl font-black mt-0.5">&#x20B9;{amt.toLocaleString("en-IN",{minimumFractionDigits:0})}</p>
              </div>
            ))}
          </div>
          {filteredInvoiced.length===0?(
            <div className="text-center py-16 text-gray-400">
              <p className="text-3xl mb-2">&#x1F4C4;</p>
              <p className="font-medium">No orders found.</p>
            </div>
          ):(
            <div className="space-y-2">
              {filteredInvoiced.map((o,i)=>(
                <div key={i} className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between gap-4 hover:shadow-sm transition-all">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-800 text-sm">{o.customerName}</span>
                      <span className="text-xs font-mono bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{o.orderNo}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${o.type==="B2B"?"bg-blue-100 text-blue-700":"bg-emerald-100 text-emerald-700"}`}>{o.type}</span>
                      {o.invNos&&<span className="text-xs text-gray-400 font-mono">{o.invNos}</span>}
                      <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{o.docType}</span>
                      <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{o.status}</span>
                      {(()=>{const cb=channelBadge(o.channel);return <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${cb.cls}`}>{cb.icon} {cb.label}</span>;})()}
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <span className="text-xs text-gray-400">{o.orderDate}</span>
                      <span className="text-xs text-emerald-600 font-semibold">Paid &#x20B9;{o.paidAmt.toLocaleString("en-IN",{minimumFractionDigits:2})}</span>
                      {o.status!=="Cancelled"&&o.balance>0.01&&<span className="text-xs text-orange-500 font-semibold">Due &#x20B9;{o.balance.toLocaleString("en-IN",{minimumFractionDigits:2})}</span>}
                      {o.status!=="Cancelled"&&o.balance<=0.01&&<span className="text-xs text-emerald-500 font-semibold">Fully paid</span>}
                      {o.status==="Cancelled"&&<span className="text-xs text-red-400 font-semibold">Cancelled — no balance due</span>}
                    </div>
                  </div>
                  <span className="font-bold text-slate-800 text-base shrink-0">&#x20B9;{o.invoicedAmt.toLocaleString("en-IN",{minimumFractionDigits:2})}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ─── Inventory ───────────────────────────────────────────────────────────────
const FILAMENT_MATERIALS = ["PLA","PETG","ABS","ASA","TPU","Nylon","PC","PLA+","PLA-CF","PETG-CF","ABS-CF","Resin"];

function AddPriceRow({ materialList=[], fps={}, seller={}, setSeller=()=>{} }) {
  const [nb, setNb] = useState("");
  const [nm, setNm] = useState(materialList[0]||"PLA");
  const [np, setNp] = useState("");
  return (
    <div className="flex flex-col gap-2 mt-2 p-3 bg-indigo-50/50 rounded-xl border border-indigo-100">
      <div className="flex gap-2">
        <input value={nb} onChange={e=>setNb(e.target.value)} placeholder="Brand (e.g. Bambu)"
          className="flex-1 border border-indigo-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"/>
        <select value={nm} onChange={e=>setNm(e.target.value)}
          className="w-28 border border-indigo-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
          {materialList.map(m=><option key={m}>{m}</option>)}
        </select>
      </div>
      <div className="flex gap-2 items-center">
        <span className="text-gray-500 text-xs shrink-0">₹/g</span>
        <input type="number" value={np} min="0" step="0.01" onChange={e=>setNp(e.target.value)} onWheel={e=>e.target.blur()} placeholder="0.00"
          className="flex-1 border border-indigo-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"/>
        <button onClick={()=>{
          if (!np||isNaN(Number(np))) return;
          const k=`${nb.trim()}||${nm}`;
          setSeller({...seller, filamentPrices:{...(seller.filamentPrices||{}), [k]:np}});
          setNb(""); setNp("");
        }} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-lg text-sm font-semibold shrink-0">+ Add</button>
      </div>
    </div>
  );
}


const EMPTY_FILAMENT = { brand:"", material:"PLA", color:"", weightG:1000, costTotal:"", notes:"", qty:1 };
const EMPTY_COST_SPLIT = () => [{ paidBy:"", amount:"" }];

function InventoryManager({ inventory=[], setInventory, expenses=[], setExpenses, recipients=[], allRecipients=[], seller, setSeller=()=>{}, deleteInventoryItem=()=>{}, toast=()=>{}, orders=[], wastageLog=[], setWastageLog=()=>{}, readOnly=false }) {
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
  const [invTab, setInvTab] = useState("stock");
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
  // Only standalone wastage (no orderNo) — order-linked waste already counted via filamentUsage
  wastageLog.forEach(w => {
    inventory.filter(i=>`${i.brand||""}||${i.material}||${i.color||""}`===w.groupKey).forEach(i=>{
      usedPerSpool[i.id] = (usedPerSpool[i.id]||0);
    });
  });
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
    const newItems = validRows.flatMap(r=>{
      const count = Math.max(1, Number(r.qty)||1);
      return Array.from({length:count}, (_,i)=>({
        id:"FIL-"+Date.now()+"-"+Math.random().toString(36).slice(2,6)+"-"+i,
        brand:r.brand, material:r.material, color:r.color,
        weightG:Number(r.weightG)||1000, notes:r.notes||"",
        purchaseDate, costTotal:Number(r.costTotal)||0, linkedExpenseIds:[],
      }));
    });
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
    const totalSpools = newItems.length;
    const rowCount = validRows.length;
    toast(`Added ${totalSpools} spool${totalSpools>1?"s":""} (${rowCount} filament${rowCount>1?" types":""})${newExpenses.length?" + "+newExpenses.length+" expense"+(newExpenses.length>1?"s":""):""}`);
  };

  const handleDelete = (item) => {
    if (!window.confirm("Delete this filament entry?")) return;
    setInventory(prev=>prev.filter(i=>i.id!==item.id));
    deleteInventoryItem(item);
  };

  const byMaterial = {};
  filtered.forEach(i=>{ if(!byMaterial[i.material]) byMaterial[i.material]={count:0,nonEmpty:0,weight:0,remaining:0}; byMaterial[i.material].count++; const r=getRemainingG(i); byMaterial[i.material].weight+=Number(i.weightG||0); byMaterial[i.material].remaining+=r; if(r>0) byMaterial[i.material].nonEmpty++; });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h2 className="font-bold text-lg text-slate-800">Filament Inventory</h2>
        <div className="flex items-center gap-2">
          {invTab==="stock"&&!readOnly&&<button onClick={()=>setShowForm(v=>!v)} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg text-xs font-semibold">{showForm?"Cancel":"+ Add Stock"}</button>}
          {invTab==="wastage"&&!readOnly&&<button onClick={()=>setShowWasteForm(v=>!v)} className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-1.5 rounded-lg text-xs font-semibold">{showWasteForm?"Cancel":"+ Record Wastage"}</button>}
        </div>
      </div>
      {/* Sub-tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 overflow-x-auto scrollbar-none w-fit max-w-full">
        {[["stock","Stock"],["pricing","₹ Pricing"],["wastage","Wastage"]].map(([id,label])=>(
          <button key={id} onClick={()=>{setInvTab(id);setShowForm(false);setShowWasteForm(false);}}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${invTab===id?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700"}`}>
            {label}
          </button>
        ))}
      </div>

      {invTab==="stock"&&showForm&&(
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
              <div key={idx} className="bg-white border border-gray-200 rounded-xl p-3 relative">
                {rows.length>1&&<button onClick={()=>removeRow(idx)} className="absolute top-2 right-2 text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pr-5">
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
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Quantity <span className="text-gray-400 font-normal normal-case text-xs">spools</span></label>
                    <input type="number" value={row.qty??""} min="1" step="1" onChange={e=>updRow(idx,"qty",e.target.value===""?"":Math.max(1,parseInt(e.target.value)||1))} onBlur={e=>{if(!e.target.value||Number(e.target.value)<1)updRow(idx,"qty",1);}} onWheel={e=>e.target.blur()}
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
        {invTab==="stock"&&(
        <div className="space-y-3">
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
          if (rem > 0) groups[key].spoolsLeft = (groups[key].spoolsLeft||0) + 1;
        });
        return (
          <div className="space-y-2">
            {Object.values(groups).map((g,gi)=>{
              const pct = g.totalWeight>0 ? Math.round(g.totalRemaining/g.totalWeight*100) : 100;
              const c = pct>50?"text-emerald-600":pct>20?"text-amber-500":"text-red-500";
              const barC = pct>50?"bg-emerald-400":pct>20?"bg-amber-400":"bg-red-400";
              return (
                <div key={gi} className="bg-white border border-gray-200 rounded-xl px-4 py-3 hover:shadow-sm transition-all">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${matColors[g.material]||"bg-gray-100 text-gray-600"}`}>{g.material}</span>
                        <p className="text-sm font-bold text-slate-800">{g.brand||<span className="text-gray-400 font-normal">No brand</span>} <span className="font-normal text-gray-500">· {g.color||"No colour"}</span></p>
                      </div>
                      <div className="min-w-0">
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
                            {rem<Number(item.weightG||0)&&<span className={`text-xs font-semibold ${c2}`}>{rem.toFixed(0)}g left ({p2}%)</span>}
                            {item.notes&&<span className="text-xs text-gray-400 italic">{item.notes}</span>}
                          </div>
                          {!readOnly&&<button onClick={()=>handleDelete(item)} className="text-xs text-red-300 hover:text-red-500 font-bold leading-none shrink-0">×</button>}
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
          <div key={item.id} className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between gap-4 hover:shadow-sm transition-all">
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
            {!readOnly&&<button onClick={()=>handleDelete(item)} className="text-xs border border-red-100 text-red-400 hover:bg-red-50 px-2.5 py-1.5 rounded-lg shrink-0 transition-all">×</button>}
          </div>
        ))}
      </div>
      )}

      </div>
      )}

      {invTab==="pricing"&&(
        <div className="space-y-3">
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
                  <div key={key} className="flex flex-col md:flex-row md:items-center gap-2 py-2 border-b border-gray-200 last:border-0">
                    <span className="font-medium text-slate-700 text-sm flex-1 min-w-0 truncate">{brand||"—"}</span>
                    <span className="text-xs bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-medium shrink-0">{mat}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs text-gray-400">₹/g</span>
                      <input type="number" value={ppg} min="0" step="0.01" disabled={readOnly}
                        onChange={e=>{ if(!readOnly){const nfp={...fps,[key]:e.target.value}; setSeller({...seller,filamentPrices:nfp});} }}
                        onWheel={e=>e.target.blur()} placeholder="0.00"
                        className={"w-20 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"+(readOnly?" bg-gray-100 text-gray-400":"")}/>
                      {!readOnly&&<button onClick={()=>{ const nfp={...fps}; delete nfp[key]; setSeller({...seller,filamentPrices:nfp}); }}
                        className="text-red-400 hover:text-red-600 font-bold text-lg leading-none px-1">×</button>}
                    </div>
                  </div>
                );
              })}
              {!readOnly&&<AddPriceRow materialList={materialList} fps={fps} seller={seller} setSeller={setSeller}/>}
            </div>
          );
        })()}
        </div>
      )}

      </div>
      {invTab==="wastage"&&(
        <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-bold text-slate-700">Wastage Log</p>
            <p className="text-xs text-gray-400">Record filament lost to testing, prototypes, jams, etc.</p>
          </div>

        </div>

        {showWasteForm&&(
          <div className="bg-orange-50/60 border border-orange-100 rounded-xl p-3 space-y-3">
            <p className="text-xs font-semibold text-orange-600 uppercase tracking-wide">New Wastage Entry</p>

            {/* Date + Reason row */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
              {!readOnly&&<button onClick={()=>setWastageLog(prev=>prev.filter(x=>x.id!==w.id))}
                className="text-red-300 hover:text-red-500 font-bold text-lg leading-none shrink-0">×</button>}
            </div>
          ))}
        </div>
        </div>
      )}
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function SettlementForm({ fromId, fromName, net, recipients, allRecipients, seller, summaries, onSettle, readOnly=false }) {
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

  if (!open) return readOnly ? null : (
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

function Dashboard({ orders, expenses, recipients, allRecipients=[], seller, settlements=[], setSettlements=()=>{}, readOnly=false }) {
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
      if (!p.receivedBy || p.receivedBy === "__company__") return;
      if (p.isRefund && num(p.amount) > 0) {
        // Recipient paid refund on company's behalf → company owes them
        const refundLabel = `Refund paid to ${p.refundTo||o.customerName} — ${o.orderNo}`;
        addEntry(p.receivedBy, p.amount, "expenses", refundLabel, p.date, p.txnRef || "");
      } else if (!p.isRefund && num(p.amount) > 0) {
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
            <div key={s.id} className="border border-gray-200 rounded-xl bg-white overflow-hidden">
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

                  {/* Net total + Record settlement — shown at top */}
                  <div className="flex items-center justify-between pb-2 border-b border-gray-100">
                    <span className={`text-sm font-black ${s.net>0?"text-emerald-600":s.net<0?"text-orange-500":"text-gray-400"}`}>
                      {s.net===0?"✓ Settled":`₹${fmt(Math.abs(s.net))}`}
                    </span>
                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">
                      {s.net>0?`${s.name} owes company`:s.net<0?`Company owes ${s.name}`:"Settled"}
                    </span>
                  </div>
                  <SettlementForm
                    readOnly={readOnly}
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
                      {s.entries.settlements.slice().reverse().map((st,si)=>(
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
      if (!r.ok) {
        const msg = data.error_description || data.msg || data.error || "Login failed";
        if (r.status===400) throw new Error("Invalid email or password. Please check your credentials.");
        if (r.status===422) throw new Error("Email format is invalid.");
        if (r.status===429) throw new Error("Too many login attempts. Please wait a moment.");
        throw new Error(msg);
      }
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
    },
    refreshToken: async (refreshToken) => {
      const r = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": key },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      if (!r.ok) return null;
      return r.json(); // { access_token, refresh_token, user }
    }
  };
  return { from, auth };
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin, sbUrl, sbKey }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async () => {
    if (!email || !password) { setError("Please enter email and password"); return; }
    if (!sbUrl || !sbKey) { setError("Supabase not configured. Check environment variables."); return; }
    setLoading(true); setError("");
    try {
      // 1. Sign in via Supabase Auth
      const client = createSupabaseClient(sbUrl, sbKey);
      const data = await client.auth.signIn(email, password);
      const token = data.access_token;
      const authUser = data.user;

      // 2. Fetch user_roles — graceful fallback if table doesn't exist yet
      let roleRow = null;
      try {
        const roleRes = await fetch(
          `${sbUrl}/rest/v1/user_roles?user_id=eq.${authUser.id}&select=user_id,email,is_admin,permissions,is_active`,
          {headers:{"apikey":sbKey,"Authorization":`Bearer ${token}`,"Content-Type":"application/json"}}
        );
        if (roleRes.ok) {
          const rows = await roleRes.json();
          roleRow = rows?.[0] || null;
          // If no row yet, create one (first login = admin)
          if (!roleRow) {
            // New user — always create with no permissions and no admin.
            // Admin must manually grant access via the Admin panel or SQL.
            const newRole = {
              user_id:authUser.id, email:authUser.email,
              is_admin: false,
              permissions: Object.fromEntries(ALL_TABS.map(t=>[t,"none"])),
              is_active: true
            };
            await fetch(`${sbUrl}/rest/v1/user_roles`,{method:"POST",
              headers:{"apikey":sbKey,"Authorization":`Bearer ${token}`,"Content-Type":"application/json","Prefer":"return=minimal"},
              body:JSON.stringify(newRole)}).catch(()=>{});
            roleRow = newRole;
          }
        }
      } catch(e) { console.warn("user_roles table missing — run SQL migrations"); }

      // Fallback only if table completely missing — default to NO access, not admin
      if (!roleRow) {
        roleRow = {user_id:authUser.id, email:authUser.email, is_admin:false, permissions:Object.fromEntries(ALL_TABS.map(t=>[t,"none"])), is_active:true};
      }

      if (roleRow.is_active===false) { setError("Your account has been deactivated. Contact admin."); setLoading(false); return; }

      const userData = {
        id: authUser.id,
        email: authUser.email,
        username: authUser.email.split("@")[0],
        isAdmin: !!roleRow.is_admin,
        permissions: roleRow.is_admin ? Object.fromEntries(ALL_TABS.map(t=>[t,"write"])) : (roleRow.permissions || {})
      };

      // 4. Log session (fire-and-forget — don't fail login if table missing)
      const sessionId = crypto.randomUUID();
      fetch(`${sbUrl}/rest/v1/app_sessions`,{method:"POST",
        headers:{"apikey":sbKey,"Authorization":`Bearer ${token}`,"Content-Type":"application/json","Prefer":"return=minimal"},
        body:JSON.stringify({id:sessionId,user_id:authUser.id,username:userData.username,login_at:new Date().toISOString()})
      }).catch(()=>{});

      sessionStorage.setItem("app_user", JSON.stringify(userData));
      sessionStorage.setItem("app_session_id", sessionId);
      if (data.refresh_token) sessionStorage.setItem("sb_refresh_token", data.refresh_token);
      onLogin(token, userData);
    } catch(e) {
      setError(e.message||"Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-slate-50 flex items-center justify-center px-4 py-8">
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
              <div className="relative">
                <input
                  type={showPw?"text":"password"} value={password} onChange={e=>setPassword(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&handleLogin()}
                  placeholder="••••••••"
                  className="w-full border border-gray-200 rounded-lg px-4 py-2.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white text-slate-800"
                />
                <button type="button" onClick={()=>setShowPw(v=>!v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm select-none">
                  {showPw?"🙈":"👁"}
                </button>
              </div>
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
function BulkDownload({ orders=[], quotations=[], proformas=[], taxInvoices=[], seller={}, expenses=[], subTabPerms=null }) {
  const canDlTab = (id) => !subTabPerms || subTabPerms[id]==="read"||subTabPerms[id]==="write";
  const firstDlTab = ["invoices","reports","gstr1"].find(t=>canDlTab(t)) || "invoices";
  const thisMonth = new Date().toISOString().slice(0,7);
  const threeMonthsAgo = (()=>{ const d=new Date(); d.setMonth(d.getMonth()-2); return d.toISOString().slice(0,7); })();
  const [from, setFrom] = useState(threeMonthsAgo);
  const [to, setTo] = useState(thisMonth);
  const [custTypes, setCustTypes] = useState(['B2B','B2C']);
  const [orderStatuses, setOrderStatuses] = useState(['Pending','Completed','Cancelled']);
  const [balanceFilter, setBalanceFilter] = useState('all');
  const [docTypes, setDocTypes] = useState(['quotation','proforma','tax']);
  const [status, setStatus] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState({done:0,total:0});
  const [subTab, setSubTab] = useState(firstDlTab);
  const [reportPeriod, setReportPeriod] = useState('month');
  const [reportMonth, setReportMonth] = useState(thisMonth);
  const [reportYear, setReportYear] = useState(String(new Date().getFullYear()));
  const [fyYear, setFyYear] = useState(String(new Date().getMonth()>=3?new Date().getFullYear():new Date().getFullYear()-1));
  const [gstrMonth, setGstrMonth] = useState(thisMonth);

  const num = (v) => Number(v||0);
  const fmt2 = (n) => Number(n||0).toFixed(2);
  const MONTH_NAMES = {'01':'Jan','02':'Feb','03':'Mar','04':'Apr','05':'May','06':'Jun','07':'Jul','08':'Aug','09':'Sep','10':'Oct','11':'Nov','12':'Dec'};

  const inRange = (dateStr) => { if (!dateStr) return false; const ym=dateStr.slice(0,7); return ym>=from&&ym<=to; };
  const getOrder = (inv) => orders.find(o=>o.orderNo===inv.orderId)||{};

  const getOrderBalance = (order) => {
    const tiTotal = taxInvoices.filter(t=>t.orderId===order.orderNo).reduce((s,t)=>s+(t.amount||(t.items?.reduce((a,i)=>a+num(i.netAmt),0)||0)+(t.charges||[]).reduce((a,c)=>a+num(c.amount),0)),0);
    const qtTotal = quotations.filter(q=>q.orderId===order.orderNo).reduce((s,q)=>s+(q.amount||0),0);
    const orderTotal = tiTotal>0?tiTotal:qtTotal;
    const totalPaid = (order.payments||[]).reduce((s,p)=>s+(p.isRefund?-num(p.amount):num(p.amount)),0)+num(order.advance);
    if (order.status==="Cancelled") return 0;
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

  const reportLabel = reportPeriod==='month'
    ? `${MONTH_NAMES[reportMonth.slice(5,7)]||''}_${reportMonth.slice(0,4)}`
    : reportPeriod==='year' ? reportYear
    : `FY_${fyYear}-${String(Number(fyYear)+1).slice(2)}`;

  const inReportRange = (dateStr) => {
    if (!dateStr) return false;
    if (reportPeriod==='month') return dateStr.startsWith(reportMonth);
    if (reportPeriod==='year') return dateStr.startsWith(reportYear);
    if (reportPeriod==='fy') {
      const d=new Date(dateStr), m=d.getMonth()+1, y=d.getFullYear(), fy=Number(fyYear);
      return (y===fy&&m>=4)||(y===fy+1&&m<=3);
    }
    return false;
  };

  const buildReports = () => {
    const filteredOrders = orders.filter(o=>inReportRange(o.orderDate));
    const filteredTIs = taxInvoices.filter(t=>inReportRange(t.invDate));
    const filteredExp = (expenses||[]).filter(e=>!e.isDeleted&&inReportRange(e.date));
    const activeOrds = filteredOrders.filter(o=>o.status!=="Cancelled");

    const getGross = (o) => {
      const tis=taxInvoices.filter(t=>t.orderId===o.orderNo);
      const qt=quotations.find(q=>q.orderId===o.orderNo);
      if(o.status==="Cancelled")return 0;
      return tis.length?tis.reduce((a,t)=>a+(t.items?.reduce((b,i)=>b+num(i.grossAmt),0)||0),0)
        :(qt?(qt.items?.reduce((b,i)=>b+num(i.grossAmt),0)||num(qt.amount))
          :(o.items||[]).reduce((a,i)=>a+num(i.grossAmt),0));
    };
    const getInvoiceVal = (o) => {
      const tis=taxInvoices.filter(t=>t.orderId===o.orderNo);
      const qt=quotations.find(q=>q.orderId===o.orderNo);
      return tis.length?tis.reduce((a,t)=>a+(t.amount||t.items?.reduce((b,i)=>b+num(i.netAmt),0)||0),0):(qt?num(qt.amount):(o.items||[]).reduce((a,i)=>a+num(i.netAmt),0));
    };
    const getPaid = (o) => num(o.advance)+(o.payments||[]).reduce((s,p)=>s+(p.isRefund?-num(p.amount):num(p.amount)),0);

    const completedOrds=filteredOrders.filter(o=>o.status==="Completed");
    const pendingCompletedOrds=filteredOrders.filter(o=>o.status==="Completed"||o.status==="Pending");
    const grossRev=completedOrds.reduce((s,o)=>s+getGross(o),0); // revenue = grossAmt, completed only
    const orderValNet=pendingCompletedOrds.reduce((s,o)=>s+getGross(o),0); // net excl GST
    const orderVal=pendingCompletedOrds.reduce((s,o)=>s+getInvoiceVal(o),0); // gross incl GST+charges
    const collected=filteredOrders.reduce((s,o)=>s+getPaid(o),0);
    const totalExp=filteredExp.reduce((s,e)=>s+num(e.amount),0);
    const cgstTotal=filteredTIs.reduce((s,t)=>s+(t.items?.reduce((a,i)=>a+num(i.cgstAmt),0)||0),0);
    const sgstTotal=filteredTIs.reduce((s,t)=>s+(t.items?.reduce((a,i)=>a+num(i.sgstAmt),0)||0),0);
    const igstTotal=filteredTIs.reduce((s,t)=>s+(t.items?.reduce((a,i)=>a+(num(i.cgstAmt)===0&&num(i.sgstAmt)===0&&num(i.netAmt)>num(i.grossAmt)?num(i.netAmt)-num(i.grossAmt):0),0)||0),0);
    const totalGST=cgstTotal+sgstTotal+igstTotal;
    const netProfit=collected-totalExp;
    const b2bGross=completedOrds.filter(o=>o.type==="B2B").reduce((s,o)=>s+getGross(o),0);
    const onlineGross=completedOrds.filter(o=>(o.channel||"Offline")!=="Offline").reduce((s,o)=>s+getGross(o),0);

    const sheet1 = [
      {Metric:"Report Period",Value:reportLabel.replace(/_/g," ")},
      {Metric:"Generated On",Value:new Date().toLocaleDateString("en-IN")},
      {Metric:""},
      {Metric:"=== REVENUE (excl. GST) ==="},
      {Metric:"Revenue (excl. GST, Completed orders)",Value:fmt2(grossRev)},
      {Metric:"Order Value Net (excl. GST)",Value:fmt2(orderValNet)},
      {Metric:"Order Value Gross (incl. GST+charges)",Value:fmt2(orderVal)},

      {Metric:"B2B Revenue",Value:fmt2(b2bGross)},
      {Metric:"B2C Revenue",Value:fmt2(grossRev-b2bGross)},
      {Metric:"Online Revenue",Value:fmt2(onlineGross)},
      {Metric:"Offline Revenue",Value:fmt2(grossRev-onlineGross)},
      {Metric:""},
      {Metric:"=== COLLECTIONS ==="},
      {Metric:"Total Collected",Value:fmt2(collected)},
      {Metric:"Outstanding Balance",Value:fmt2(Math.max(0,orderVal-collected))},
      {Metric:"Collection Rate %",Value:grossRev>0?fmt2(collected/grossRev*100)+"%":"0%"},
      {Metric:""},
      {Metric:"=== GST / TAX ==="},
      {Metric:"Total GST Collected",Value:fmt2(totalGST)},
      {Metric:"CGST",Value:fmt2(cgstTotal)},
      {Metric:"SGST",Value:fmt2(sgstTotal)},
      {Metric:"IGST",Value:fmt2(igstTotal)},
      {Metric:""},
      {Metric:"=== EXPENSES & PROFIT ==="},
      {Metric:"Total Expenses",Value:fmt2(totalExp)},
      {Metric:"Net Profit",Value:fmt2(netProfit)},
      {Metric:"Profit Margin %",Value:collected>0?fmt2(netProfit/collected*100)+"%":"0%"},
      {Metric:""},
      {Metric:"=== ORDERS ==="},
      {Metric:"Total Orders",Value:filteredOrders.length},
      {Metric:"Completed",Value:filteredOrders.filter(o=>o.status==="Completed").length},
      {Metric:"Pending",Value:filteredOrders.filter(o=>o.status==="Pending").length},
      {Metric:"Cancelled",Value:filteredOrders.filter(o=>o.status==="Cancelled").length},
      {Metric:"B2B Orders",Value:activeOrds.filter(o=>o.type==="B2B").length},
      {Metric:"B2C Orders",Value:activeOrds.filter(o=>o.type==="B2C").length},
      {Metric:"Tax Invoices",Value:filteredTIs.length},
    ];

    const mapTIRow = (t,type) => {
      const o=getOrder(t);
      const taxable=t.items?.reduce((s,i)=>s+num(i.grossAmt),0)||0;
      const cgst=t.items?.reduce((s,i)=>s+num(i.cgstAmt),0)||0;
      const sgst=t.items?.reduce((s,i)=>s+num(i.sgstAmt),0)||0;
      const igst=t.items?.reduce((s,i)=>num(i.cgstAmt)===0&&num(i.sgstAmt)===0?s+num(i.netAmt)-num(i.grossAmt):s,0)||0;
      return {"Invoice No":t.invNo,"Date":t.invDate,"Order No":t.orderId,"Customer":o.customerName||"","GSTIN":o.gstin||"","Taxable Value":fmt2(taxable),"CGST Rate %":cgst>0?t.items?.[0]?.cgstRate||9:"","CGST Amount":fmt2(cgst),"SGST Rate %":sgst>0?t.items?.[0]?.sgstRate||9:"","SGST Amount":fmt2(sgst),"IGST Amount":fmt2(igst),"Total":fmt2(taxable+cgst+sgst+igst)};
    };
    const b2bRows=filteredTIs.filter(t=>(getOrder(t).type||"B2B")==="B2B").map(t=>mapTIRow(t,"B2B"));
    const b2cRows=filteredTIs.filter(t=>(getOrder(t).type||"B2B")!=="B2B").map(t=>mapTIRow(t,"B2C"));

    const hsnMap={};
    filteredTIs.forEach(t=>{
      const o=getOrder(t);
      (t.items||[]).forEach(i=>{
        const hsn=i.hsn||"—";
        if(!hsnMap[hsn])hsnMap[hsn]={hsn,desc:i.item||"",b2b_taxable:0,b2c_taxable:0,taxable:0,cgst:0,sgst:0,igst:0,total:0};
        const ig=num(i.cgstAmt)===0&&num(i.sgstAmt)===0?num(i.netAmt)-num(i.grossAmt):0;
        hsnMap[hsn].taxable+=num(i.grossAmt);
        hsnMap[hsn].cgst+=num(i.cgstAmt);
        hsnMap[hsn].sgst+=num(i.sgstAmt);
        hsnMap[hsn].igst+=ig;
        hsnMap[hsn].total+=num(i.netAmt);
        if(o.type==="B2B")hsnMap[hsn].b2b_taxable+=num(i.grossAmt);
        else hsnMap[hsn].b2c_taxable+=num(i.grossAmt);
      });
    });
    const hsnRows=Object.values(hsnMap).sort((a,b)=>b.taxable-a.taxable).map(h=>({
      "HSN":h.hsn,"Description":h.desc,
      "B2B Taxable":fmt2(h.b2b_taxable),"B2C Taxable":fmt2(h.b2c_taxable),"Total Taxable":fmt2(h.taxable),
      "CGST":fmt2(h.cgst),"SGST":fmt2(h.sgst),"IGST":fmt2(h.igst),"Total Tax":fmt2(h.cgst+h.sgst+h.igst),
      "Grand Total":fmt2(h.total)
    }));

    return {sheet1,b2bRows,b2cRows,hsnRows};
  };

  const downloadReports = async () => {
    const {sheet1,b2bRows,b2cRows,hsnRows}=buildReports();
    const fname=`Financial_Report_${reportLabel}.xlsx`;
    try {
      const XLSX=await import("https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs");
      const wb=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(sheet1),"Financial Summary");
      if(b2bRows.length)XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(b2bRows),"B2B Tax Invoices");
      if(b2cRows.length)XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(b2cRows),"B2C Tax Invoices");
      if(hsnRows.length)XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(hsnRows),"HSN Summary");
      XLSX.writeFile(wb,fname);
    } catch(e){
      await exportToExcel(sheet1,fname.replace(".xlsx",""));
    }
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
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="font-bold text-lg text-slate-800">Downloads</h2>
        <p className="text-xs text-gray-400">Download invoices as PDF or export financial reports as Excel.</p>
      </div>
      {/* Sub-tab */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
        {[["invoices","📄 Invoice Downloads"],["reports","📊 Financial Reports"],["gstr1","🇮🇳 GSTR-1"]].filter(([id])=>canDlTab(id)).map(([id,lb])=>(
          <button key={id} onClick={()=>setSubTab(id)}
            className={"flex-1 py-2 px-1 rounded-lg text-[10px] md:text-xs font-semibold transition-all text-center whitespace-nowrap "+(subTab===id?"bg-white text-indigo-700 shadow-sm":"text-gray-500 hover:text-gray-700")}>
            {lb}
          </button>
        ))}
      </div>

      {subTab==="reports"&&canDlTab("reports")&&(
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm space-y-3">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Select Period</p>
            <div className="flex gap-2 flex-wrap">
              {[["month","Monthly"],["year","Yearly"],["fy","Financial Year (Apr-Mar)"]].map(([v,l])=>(
                <button key={v} onClick={()=>setReportPeriod(v)}
                  className={"px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all "+(reportPeriod===v?"bg-indigo-600 text-white border-indigo-600":"border-gray-200 text-gray-600 hover:border-indigo-300")}>
                  {l}
                </button>
              ))}
            </div>
            {reportPeriod==="month"&&<input type="month" value={reportMonth} onChange={e=>setReportMonth(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>}
            {reportPeriod==="year"&&<input type="number" value={reportYear} onChange={e=>setReportYear(e.target.value)} min="2020" max="2099" placeholder="2025" className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-indigo-400"/>}
            {reportPeriod==="fy"&&<div className="flex items-center gap-2"><input type="number" value={fyYear} onChange={e=>setFyYear(e.target.value)} min="2020" max="2099" className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-indigo-400"/><span className="text-xs text-gray-500">Apr {fyYear} – Mar {Number(fyYear)+1}</span></div>}
          </div>
          {(()=>{
            const {sheet1,b2bRows,b2cRows,hsnRows}=buildReports();
            const get=(k)=>sheet1.find(r=>r.Metric===k)?.Value||"—";
            return (
              <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm space-y-3">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Preview</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {[["Gross Revenue","Gross Revenue","#6366f1"],["Collected","Total Collected","#10b981"],["GST","Total GST Collected","#f59e0b"],["Net Profit","Net Profit","#8b5cf6"]].map(([l,k,c])=>(
                    <div key={l} className="bg-gray-50 rounded-xl p-3">
                      <p className="text-[10px] text-gray-400">{l}</p>
                      <p className="text-sm font-black" style={{color:c}}>₹{get(k)}</p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400">Sheets: Financial Summary · {b2bRows.length} B2B Invoices · {b2cRows.length} B2C Invoices · {hsnRows.length} HSN lines</p>
              </div>
            );
          })()}
          <button onClick={downloadReports}
            className="w-full py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-sm hover:shadow-md hover:scale-[1.01] transition-all">
            ⬇ Download Excel — {reportLabel.replace(/_/g," ")}
          </button>
        </div>
      )}


      {subTab==="gstr1"&&canDlTab("gstr1")&&(
        <div className="space-y-4">
          {/* Month selector */}
          <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm space-y-3">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">GSTR-1 Period</p>
            <div className="flex items-center gap-3">
              <input type="month" value={gstrMonth} onChange={e=>setGstrMonth(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
              <span className="text-xs text-gray-400">GSTIN: <strong>{seller?.gstin||"—"}</strong></span>
            </div>
          </div>

          {(()=>{
            const num = (v) => Number(v||0);
            const fmt2 = (n) => Number(n||0).toFixed(2);
            const monthTIs = taxInvoices.filter(t=>t.invDate?.startsWith(gstrMonth));
            const sellerState = seller?.stateCode||"";
            const extractSC = (sc) => { if(!sc)return ""; const m=sc.match(/^(\d{2})/); return m?m[1]:sc.slice(0,2); };
            const isInterState = (order) => {
              const custState = order.type==="B2B"
                ? extractSC(order.billingStateCode)
                : extractSC(order.shippingStateCode||order.billingStateCode);
              return sellerState && custState && extractSC(sellerState)!==custState;
            };

            // ── 4A: B2B Regular invoices ──────────────────────────────────────
            const b2bTIs = monthTIs.filter(t=>{
              const o=orders.find(ord=>ord.orderNo===t.orderId);
              return o?.type==="B2B" && o?.needsGst;
            });
            const sheet4A = b2bTIs.map(t=>{
              const o=orders.find(ord=>ord.orderNo===t.orderId)||{};
              const taxable=t.items?.reduce((s,i)=>s+num(i.grossAmt),0)||0;
              const cgst=t.items?.reduce((s,i)=>s+num(i.cgstAmt),0)||0;
              const sgst=t.items?.reduce((s,i)=>s+num(i.sgstAmt),0)||0;
              const igst=t.items?.reduce((s,i)=>num(i.cgstAmt)===0&&num(i.sgstAmt)===0?s+num(i.netAmt)-num(i.grossAmt):s,0)||0;
              const cess=0;
              return {
                "GSTIN/UIN of Recipient":o.gstin||"",
                "Receiver Name":o.billingName||o.customerName||"",
                "Invoice Number":t.invNo,
                "Invoice Date":t.invDate,
                "Invoice Value":fmt2(taxable+cgst+sgst+igst),
                "Place of Supply":o.placeOfSupply||o.billingStateCode||"",
                "Reverse Charge":"N",
                "Invoice Type":"Regular",
                "E-Commerce GSTIN":"",
                "Rate":t.items?.[0]?.cgstRate&&t.items?.[0]?.sgstRate?(num(t.items[0].cgstRate)+num(t.items[0].sgstRate)).toFixed(0):"18",
                "Taxable Value":fmt2(taxable),
                "Integrated Tax":fmt2(igst),
                "Central Tax":fmt2(cgst),
                "State/UT Tax":fmt2(sgst),
                "Cess":fmt2(cess)
              };
            });

            // ── 5: B2C Large (inter-state, >₹2.5L invoice value) ─────────────
            const b2cLargeTIs = monthTIs.filter(t=>{
              const o=orders.find(ord=>ord.orderNo===t.orderId);
              if(!o||o.type==="B2B")return false;
              const val=t.items?.reduce((s,i)=>s+num(i.netAmt),0)||0;
              return isInterState(o)&&val>250000;
            });
            const sheet5 = b2cLargeTIs.map(t=>{
              const o=orders.find(ord=>ord.orderNo===t.orderId)||{};
              const taxable=t.items?.reduce((s,i)=>s+num(i.grossAmt),0)||0;
              const igst=t.items?.reduce((s,i)=>s+num(i.netAmt)-num(i.grossAmt),0)||0;
              return {
                "Invoice Number":t.invNo,
                "Invoice Date":t.invDate,
                "Invoice Value":fmt2(taxable+igst),
                "Place of Supply":o.placeOfSupply||o.shippingStateCode||o.billingStateCode||"",
                "Applicable % of Tax Rate":"",
                "Rate":t.items?.[0]?.cgstRate&&t.items?.[0]?.sgstRate?(num(t.items[0].cgstRate)+num(t.items[0].sgstRate)).toFixed(0):"18",
                "Taxable Value":fmt2(taxable),
                "Integrated Tax":fmt2(igst),
                "Cess":"0.00",
                "E-Commerce GSTIN":""
              };
            });

            // ── 7: B2C Others (intra-state + inter-state ≤₹2.5L) ────────────
            // Grouped by State and Rate
            const b2cOtherTIs = monthTIs.filter(t=>{
              const o=orders.find(ord=>ord.orderNo===t.orderId);
              if(!o||o.type==="B2B")return false;
              const val=t.items?.reduce((s,i)=>s+num(i.netAmt),0)||0;
              return !isInterState(o)||(isInterState(o)&&val<=250000);
            });
            const b2cOtherMap={};
            b2cOtherTIs.forEach(t=>{
              const o=orders.find(ord=>ord.orderNo===t.orderId)||{};
              (t.items||[]).forEach(i=>{
                const rate=(num(i.cgstRate)+num(i.sgstRate)).toFixed(0);
                const pos=o.placeOfSupply||o.shippingStateCode||o.billingStateCode||"";
                const key=`${pos}||${rate}`;
                if(!b2cOtherMap[key])b2cOtherMap[key]={pos,rate,taxable:0,igst:0,cgst:0,sgst:0,cess:0};
                const ig=num(i.cgstAmt)===0&&num(i.sgstAmt)===0?num(i.netAmt)-num(i.grossAmt):0;
                b2cOtherMap[key].taxable+=num(i.grossAmt);
                b2cOtherMap[key].igst+=ig;
                b2cOtherMap[key].cgst+=num(i.cgstAmt);
                b2cOtherMap[key].sgst+=num(i.sgstAmt);
              });
            });
            const sheet7=Object.values(b2cOtherMap).map(r=>({
              "Type":"OE",
              "Applicable % of Tax Rate":"",
              "Rate":r.rate,
              "Taxable Value":fmt2(r.taxable),
              "Integrated Tax":fmt2(r.igst),
              "Central Tax":fmt2(r.cgst),
              "State/UT Tax":fmt2(r.sgst),
              "Cess":"0.00"
            }));

            // ── 12: HSN-wise Summary ──────────────────────────────────────────
            const hsnMap12={};
            monthTIs.forEach(t=>{
              (t.items||[]).forEach(i=>{
                const hsn=i.hsn||"";
                const rate=(num(i.cgstRate)+num(i.sgstRate)).toFixed(0);
                const key=`${hsn}||${rate}`;
                if(!hsnMap12[key])hsnMap12[key]={hsn,desc:i.item||"",uqc:"NOS",qty:0,val:0,taxable:0,igst:0,cgst:0,sgst:0,cess:0,rate};
                const ig=num(i.cgstAmt)===0&&num(i.sgstAmt)===0?num(i.netAmt)-num(i.grossAmt):0;
                hsnMap12[key].qty+=num(i.qty);
                hsnMap12[key].val+=num(i.netAmt);
                hsnMap12[key].taxable+=num(i.grossAmt);
                hsnMap12[key].igst+=ig;
                hsnMap12[key].cgst+=num(i.cgstAmt);
                hsnMap12[key].sgst+=num(i.sgstAmt);
              });
            });
            const sheet12=Object.values(hsnMap12).sort((a,b)=>b.taxable-a.taxable).map(h=>({
              "HSN":h.hsn,
              "Description":h.desc,
              "UQC":h.uqc,
              "Total Quantity":h.qty.toFixed(2),
              "Total Value":fmt2(h.val),
              "Rate":h.rate,
              "Taxable Value":fmt2(h.taxable),
              "Integrated Tax":fmt2(h.igst),
              "Central Tax":fmt2(h.cgst),
              "State/UT Tax":fmt2(h.sgst),
              "Cess":"0.00"
            }));

            // ── 13: Documents Issued ──────────────────────────────────────────
            const allMonthTIs = monthTIs;
            const allMonthQTs = quotations.filter(q=>q.invDate?.startsWith(gstrMonth));
            const monthLabel = `${MONTH_NAMES[gstrMonth.slice(5,7)]||""} ${gstrMonth.slice(0,4)}`;
            const sheet13=[
              {"Nature of Document":"Invoices for outward supply","Sr No From":allMonthTIs[0]?.invNo||"","Sr No To":allMonthTIs[allMonthTIs.length-1]?.invNo||"","Total Number":allMonthTIs.length,"Cancelled":0},
              {"Nature of Document":"Advance Receipt","Sr No From":"","Sr No To":"","Total Number":0,"Cancelled":0},
              {"Nature of Document":"Revised Invoice","Sr No From":"","Sr No To":"","Total Number":0,"Cancelled":0},
              {"Nature of Document":"Debit Note","Sr No From":"","Sr No To":"","Total Number":0,"Cancelled":0},
              {"Nature of Document":"Credit Note","Sr No From":"","Sr No To":"","Total Number":0,"Cancelled":0},
              {"Nature of Document":"Receipt Voucher","Sr No From":"","Sr No To":"","Total Number":0,"Cancelled":0},
              {"Nature of Document":"Payment Voucher","Sr No From":"","Sr No To":"","Total Number":0,"Cancelled":0},
              {"Nature of Document":"Refund Voucher","Sr No From":"","Sr No To":"","Total Number":0,"Cancelled":0},
            ];

            const counts = {
              b2b: sheet4A.length,
              b2cL: sheet5.length,
              b2cO: b2cOtherTIs.length,
              hsn: sheet12.length,
            };

            const downloadGSTR1 = async () => {
              try {
                const XLSX=await import("https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs");
                const wb=XLSX.utils.book_new();
                if(sheet4A.length) XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(sheet4A),"4A-B2B");
                if(sheet5.length) XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(sheet5),"5-B2C Large");
                if(sheet7.length) XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(sheet7),"7-B2C Others");
                XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(sheet12),"12-HSN");
                XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(sheet13),"13-Docs Issued");
                XLSX.writeFile(wb,`GSTR1_${seller?.gstin||"GSTIN"}_${gstrMonth}.xlsx`);
              } catch(e){
                alert("Error generating GSTR-1: "+e.message);
              }
            };

            return (
              <>
                {/* Summary tiles */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {[
                    ["4A B2B", counts.b2b+" invoices", "#6366f1"],
                    ["5 B2C Large", counts.b2cL+" invoices", "#f59e0b"],
                    ["7 B2C Others", counts.b2cO+" invoices", "#22d3ee"],
                    ["12 HSN Lines", counts.hsn+" rows", "#10b981"],
                  ].map(([l,v,c])=>(
                    <div key={l} className="bg-white border border-gray-200 rounded-xl p-3 shadow-sm">
                      <p className="text-[10px] text-gray-400 font-medium">{l}</p>
                      <p className="text-sm font-black" style={{color:c}}>{v}</p>
                    </div>
                  ))}
                </div>

                {/* Sheet previews */}
                <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm space-y-3">
                  <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Sheets in Export</p>
                  {[
                    ["4A — B2B Regular Invoices", sheet4A.length, "All B2B tax invoices with GSTIN, value, CGST/SGST/IGST"],
                    ["4B — B2B Reverse Charge", 0, "Not applicable (no RCM invoices)"],
                    ["5 — B2C Large (>₹2.5L inter-state)", sheet5.length, "Inter-state B2C invoices above ₹2.5L"],
                    ["6A — Exports", 0, "Export invoices (none detected)"],
                    ["6B/6C — Credit/Debit Notes", 0, "Not applicable"],
                    ["7 — B2C Others", sheet7.length, "All other B2C grouped by state & rate"],
                    ["12 — HSN-wise Summary", sheet12.length, "HSN code, qty, taxable value, tax breakup"],
                    ["13 — Documents Issued", sheet13.length, "Invoice serial number summary"],
                  ].map(([name, count, desc])=>(
                    <div key={name} className="flex items-start gap-3 py-1.5 border-b border-gray-200 last:border-0">
                      <span className={`text-[10px] font-black px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${count>0?"bg-indigo-100 text-indigo-700":"bg-gray-100 text-gray-400"}`}>{count}</span>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-slate-700">{name}</p>
                        <p className="text-[10px] text-gray-400">{desc}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-700">
                  <strong>Note:</strong> This export uses the GSTN-compatible column format. Import each sheet into the corresponding table in the GSTR-1 offline tool or GST portal JSON uploader. Verify values before filing.
                </div>

                <button onClick={downloadGSTR1}
                  className="w-full py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-green-600 to-emerald-600 text-white shadow-sm hover:shadow-md hover:scale-[1.01] transition-all">
                  ⬇ Download GSTR-1 — {gstrMonth} ({(sheet4A.length+sheet5.length+b2cOtherTIs.length)} invoices)
                </button>
              </>
            );
          })()}
        </div>
      )}
      {subTab==="invoices"&&canDlTab("invoices")&&(
        <div className="space-y-6">
          {/* Date range */}
          <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm space-y-4">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Date Range</p>
            <div className="flex gap-3 items-center flex-wrap">
              <div className="flex flex-col gap-1"><label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">From</label>
                <input type="month" value={from} onChange={e=>setFrom(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/></div>
              <div className="flex flex-col gap-1"><label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">To</label>
                <input type="month" value={to} onChange={e=>setTo(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/></div>
            </div>
          </div>
          {/* Filters */}
          <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm space-y-4">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Filters</p>
            <div className="space-y-3">
              <div><p className="text-xs text-gray-500 mb-1.5 font-medium">Customer Type</p>
                <div className="flex gap-2 flex-wrap">{['B2B','B2C'].map(v=><span key={v} onClick={()=>toggleArr(custTypes,setCustTypes,v)} className={chipCls(custTypes.includes(v))}>{v}</span>)}</div></div>
              <div><p className="text-xs text-gray-500 mb-1.5 font-medium">Order Status</p>
                <div className="flex gap-2 flex-wrap">{['Pending','Completed','Cancelled'].map(v=><span key={v} onClick={()=>toggleArr(orderStatuses,setOrderStatuses,v)} className={chipCls(orderStatuses.includes(v))}>{v}</span>)}</div></div>
              <div><p className="text-xs text-gray-500 mb-1.5 font-medium">Document Types</p>
                <div className="flex gap-2 flex-wrap">{[['quotation','Quotation'],['proforma','Proforma'],['tax','Tax Invoice']].map(([v,l])=><span key={v} onClick={()=>toggleArr(docTypes,setDocTypes,v)} className={chipCls(docTypes.includes(v))}>{l}</span>)}</div></div>
              <div><p className="text-xs text-gray-500 mb-1.5 font-medium">Balance</p>
                <div className="flex gap-2 flex-wrap">{[['all','All'],['no_balance','Fully Paid'],['has_balance','Has Balance']].map(([v,l])=><span key={v} onClick={()=>setBalanceFilter(v)} className={chipCls(balanceFilter===v)}>{l}</span>)}</div></div>
            </div>
          </div>
          {/* Preview tree */}
          <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">
              Will Download — <span className="text-indigo-600">{total} document{total!==1?'s':''}</span>
            </p>
            {total===0
              ? <p className="text-sm text-gray-400 italic">No documents match the filters.</p>
              : <div className="space-y-1.5 max-h-56 overflow-y-auto">
                  {treeEntries.map(e=>(
                    <div key={`${e.ct}-${e.year}-${e.month}`} className="flex items-center gap-2 text-xs text-gray-600">
                      <span className="font-mono text-gray-400 text-[10px] w-24 shrink-0">{e.ct} / {e.year} / {e.month}</span>
                      <span className="flex gap-1.5">
                        {e.qt>0&&<span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-semibold">{e.qt} QT</span>}
                        {e.pf>0&&<span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded font-semibold">{e.pf} PF</span>}
                        {e.ti>0&&<span className="px-1.5 py-0.5 bg-green-100 text-green-700 rounded font-semibold">{e.ti} TI</span>}
                      </span>
                    </div>
                  ))}
                </div>
            }
          </div>
          {/* Progress */}
          {downloading&&progress.total>0&&(
            <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm space-y-2">
              <div className="flex justify-between text-xs text-gray-500"><span>Progress</span><span>{progress.done}/{progress.total}</span></div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-indigo-500 rounded-full transition-all" style={{width:`${Math.round(progress.done/progress.total*100)}%`}}/></div>
            </div>
          )}
          {!downloading&&status&&(
            <p className={`text-sm font-medium px-4 py-2 rounded-xl ${status.startsWith('✓')?'bg-green-50 text-green-700':status.startsWith('Error')?'bg-red-50 text-red-600':'bg-gray-50 text-gray-600'}`}>{status}</p>
          )}
          <button onClick={handleDownload} disabled={downloading||total===0}
            className={`relative w-full py-3 rounded-xl font-bold text-sm tracking-wide text-white shadow-sm transition-all duration-200 ${downloading||total===0?'bg-gray-300 cursor-not-allowed':'bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 hover:shadow-md hover:scale-[1.01]'}`}>
            {downloading?`Converting ${progress.done}/${progress.total}…`:`⬇ Download ${total} PDF${total!==1?'s':''}${total>0?` (${from} → ${to})`:''}`}
          </button>
          <p className="text-xs text-gray-400 border-t border-gray-100 pt-3">Each invoice is rendered and converted to PDF client-side. Keep this tab open during conversion.</p>
        </div>
      )}
    </div>
  );
}


function App() {
  const [tab,setTab]=useState("new");
  const [viewOrder,setViewOrder]=useState(null);
  const [accessToken,setAccessToken]=useState(()=>sessionStorage.getItem("sb_token")||"");
  const accessTokenRef = useRef(accessToken);
  const [user,setUser]=useState(null);
  const [currentUser,setCurrentUser]=useState(()=>{ try{return JSON.parse(sessionStorage.getItem("app_user")||"null")}catch(e){return null} });
  const perms = currentUser?.permissions || {};
  const isAdmin = currentUser?.isAdmin===true;
  const canRead = (tabId, subTabId=null) => {
    if (isAdmin) return true;
    const p = perms[tabId];
    if (!p || p==="none") return false;
    // Simple string perm (no sub-tabs)
    if (typeof p === "string") return p==="read"||p==="write";
    // Object: check specific sub-tab
    if (subTabId) { const sv=p[subTabId]; return sv==="read"||sv==="write"; }
    // No sub-tab specified: tab accessible if ANY sub-tab is granted
    return Object.values(p).some(v=>v==="read"||v==="write");
  };
  const canWrite = (tabId, subTabId=null) => {
    if (isAdmin) return true;
    const p = perms[tabId];
    if (!p || p==="none") return false;
    if (typeof p === "string") return p==="write";
    if (subTabId) return p[subTabId]==="write";
    return Object.values(p).some(v=>v==="write");
  };
  // No permissions at all → show empty state
  const hasAnyAccess = isAdmin || ALL_TABS.some(t=>canRead(t));
  // First accessible tab for auto-redirect
  const firstAccessibleTab = isAdmin ? "analytics" : (ALL_TABS.find(t=>t!=="admin"&&canRead(t)) || null);
  const sbUrl2 = localStorage.getItem("sb_url")||getEnv("VITE_SUPABASE_URL");
  const sbKey2 = localStorage.getItem("sb_key")||getEnv("VITE_SUPABASE_KEY");
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
  const [employees,setEmployees]=useState([]);
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
        const noOrder = ["employees","products","inventory","wastage_log"].includes(table);
        const url = `${rest}/${table}?select=${cols}${noOrder?"":"&order=created_at.asc"}`;
        const r = await fetch(url, { headers: {...headers, "Prefer":"return=representation"} });
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


  // ── Auto-navigate to first accessible tab when user loads ────────────────
  useEffect(()=>{
    if (!currentUser) return;
    if (isAdmin) return; // admin stays on whatever tab
    if (firstAccessibleTab && !canRead(tab)) setTab(firstAccessibleTab);
  },[currentUser?.id]);

  // ── Mark session logged out when tab/browser closes ──────────────────────
  useEffect(()=>{
    const onUnload = () => {
      const sid = sessionStorage.getItem("app_session_id");
      const url = localStorage.getItem("sb_url")||getEnv("VITE_SUPABASE_URL");
      const key = localStorage.getItem("sb_key")||getEnv("VITE_SUPABASE_KEY");
      const token2 = sessionStorage.getItem("sb_token")||"";
      if (!sid||!url||!key||!token2) return;
      // keepalive:true ensures the request completes even when the tab closes
      fetch(`${url}/rest/v1/app_sessions?id=eq.${sid}`, {
        method:"PATCH", keepalive:true,
        headers:{"apikey":key,"Authorization":`Bearer ${token2}`,"Content-Type":"application/json","Prefer":"return=minimal"},
        body:JSON.stringify({logout_at:new Date().toISOString()})
      }).catch(()=>{});
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  },[]);

  // ── Load all data on mount ───────────────────────────────────────────────
  useEffect(()=>{
    const ENV_URL2 = getEnv("VITE_SUPABASE_URL");
    const ENV_KEY2 = getEnv("VITE_SUPABASE_KEY");
    const url = localStorage.getItem("sb_url")||ENV_URL2;
    const key = localStorage.getItem("sb_key")||ENV_KEY2;
    const token = sessionStorage.getItem("sb_token")||"";
    if (!url||!key||!token) return;
    const baseClient = createSupabaseClient(url, key);

    // ── Validate + refresh token, then load data ─────────────────────────
    (async () => {
      let activeToken = token;
      try {
        const userCheck = await baseClient.auth.getUser(token);
        if (!userCheck || userCheck.error) {
          const refreshTok = sessionStorage.getItem("sb_refresh_token");
          if (refreshTok) {
            const refreshed = await baseClient.auth.refreshToken(refreshTok);
            if (refreshed?.access_token) {
              activeToken = refreshed.access_token;
              setAccessToken(activeToken);
              sessionStorage.setItem("sb_token", activeToken);
              if (refreshed.refresh_token) sessionStorage.setItem("sb_refresh_token", refreshed.refresh_token);
            } else { handleLogout(); return; }
          } else { handleLogout(); return; }
        }
      } catch(e) { console.warn("Token check failed, proceeding:", e.message); }

      const authHeaders = { "Content-Type": "application/json", "apikey": key, "Authorization": `Bearer ${activeToken}` };
    const rest2 = `${url}/rest/v1`;
    const client = { from: (table) => ({
      select: async (cols="*") => {
        const noOrder2 = ["employees","products","inventory","wastage_log"].includes(table);
        const url2 = `${rest2}/${table}?select=${cols}${noOrder2?"":"&order=created_at.asc"}`;
        const r = await fetch(url2, { headers: {...authHeaders,"Prefer":"return=representation"} });
        if (!r.ok) return [];
        return r.json();
      }
    }), auth: baseClient.auth };
    setLoading(true);
    // Phase 1: Critical data — orders, settings, recipients (needed to render immediately)
    Promise.all([
      client.from("orders").select(),
      client.from("items").select(),
      client.from("payments").select(),
      client.from("settings").select(),
      client.from("recipients").select(),
    ]).then(([ord, allItems, pay, sets, rc]) => {
      const parseJson = (v) => { if (typeof v==="string" && (v.startsWith("{")||v.startsWith("["))) { try{return JSON.parse(v)}catch(e){return v} } return v; };
      const mapItem = (r) => ({ sl:r.sl, item:r.item||"", hsn:r.hsn||"", unit:r.unit||"Nos", unitPrice:r.unit_price, qty:r.qty, discount:r.discount, grossAmt:r.gross_amt, cgstRate:r.cgst_rate, cgstAmt:r.cgst_amt, sgstRate:r.sgst_rate, sgstAmt:r.sgst_amt, netAmt:r.net_amt, _brand:r.brand||"", _material:r.material||"", _productId:r.product_id||"" });
      const getItems = (type, id) => (allItems||[]).filter(i=>i.document_type===type&&i.document_id===id).sort((a,b)=>a.sl-b.sl).map(mapItem);
      const mapOrder = (r) => ({ orderNo:r.order_no, orderNoBase:r.order_no_base, type:r.type, customerName:r.customer_name, phone:r.phone, email:r.email, gstin:r.gstin, billingName:r.billing_name, billingAddress:r.billing_address, billingStateCode:r.billing_state_code, shippingName:r.shipping_name, shippingAddress:r.shipping_address, shippingContact:r.shipping_contact, shippingGstin:r.shipping_gstin, shippingStateCode:r.shipping_state_code, placeOfSupply:r.place_of_supply, orderDate:r.order_date, dueDate:r.due_date, paymentMode:r.payment_mode, advance:r.advance, advanceRecipient:r.advance_recipient, advanceTxnRef:r.advance_txn_ref, status:r.status, comments:r.comments, needsGst:r.needs_gst, quotationNo:r.quotation_no, proformaIds:parseJson(r.proforma_ids)||[], taxInvoiceIds:parseJson(r.tax_invoice_ids)||[], filamentUsage:(v=>Array.isArray(v)?v:[])(parseJson(r.filament_usage)), charges:(v=>Array.isArray(v)?v:[])(parseJson(r.charges)), isPickup:!!r.is_pickup, cancelReason:r.cancel_reason||"", channel:r.channel||"Offline", isReferred:r.is_referred||0, referralPerson:r.referral_person||"", referralAmount:r.referral_amount||0, referralPaid:r.referral_paid||0, referralPaidDate:r.referral_paid_date||"", referralPaidRef:r.referral_paid_ref||"", items:getItems("order",r.order_no), payments:[] });
      const mapPayment = (r) => ({ id:r.id, orderId:r.order_id, date:r.date, amount:r.amount, mode:r.mode||"", receivedBy:r.received_by||"", txnRef:r.txn_ref||"", comments:r.comments||"", isRefund:!!r.is_refund, refundTo:r.refund_to||"" });
      const payMapped = pay?.length ? pay.map(mapPayment) : [];
      if (ord?.length) setOrders(ord.map(mapOrder).map(o=>({...o,payments:payMapped.filter(p=>p.orderId===o.orderNo)})));
      if (rc?.length) { const mapped=rc.map(r=>({id:r.id,name:r.name,isDeleted:r.is_deleted||false})); setRecipients(mapped.filter(r=>!r.isDeleted)); allRecipientsRef.current=mapped; }
      if (sets?.length) { const s={}; sets.forEach(r=>{ try{s[r.key]=JSON.parse(r.value)}catch(e){s[r.key]=r.value} }); if(s.seller)setSeller(s.seller); if(s.series)setSeries(s.series); }
      setLoading(false); // ← Show UI now with orders loaded

      // Phase 2: Secondary data — load in background without blocking UI
      Promise.all([
        client.from("quotations").select(),
        client.from("proformas").select(),
        client.from("tax_invoices").select(),
        client.from("clients").select(),
        client.from("expenses").select(),
        client.from("assets").select(),
        client.from("settlements").select(),
        client.from("inventory").select(),
        client.from("wastage_log").select(),
        client.from("products").select(),
        client.from("employees").select().catch(()=>[]),
      ]).then(([qt,pf,ti,cl,ex,ass,stl,inv,wlog,prods,emps])=>{ const allItemsP2 = allItems||[];
      const parseJsonP2 = (v) => { if (typeof v==="string" && (v.startsWith("{")||v.startsWith("["))) { try{return JSON.parse(v)}catch(e){return v} } return v; };
      const mapItemP2 = (r) => ({ sl:r.sl, item:r.item||"", hsn:r.hsn||"", unit:r.unit||"Nos", unitPrice:r.unit_price, qty:r.qty, discount:r.discount, grossAmt:r.gross_amt, cgstRate:r.cgst_rate, cgstAmt:r.cgst_amt, sgstRate:r.sgst_rate, sgstAmt:r.sgst_amt, netAmt:r.net_amt, _brand:r.brand||"", _material:r.material||"", _productId:r.product_id||"" });
      const getItemsP2 = (type, id) => (allItemsP2||[]).filter(i=>i.document_type===type&&i.document_id===id).sort((a,b)=>a.sl-b.sl).map(mapItemP2);
      const mapInv = (type) => (r) => ({ invNo:r.inv_no, invNoBase:r.inv_no_base, invDate:r.inv_date, orderId:r.order_id, amount:r.amount, notes:r.notes||"", items:getItemsP2(type,r.inv_no), sellerSnapshot: r.seller_snapshot ? (()=>{try{return JSON.parse(r.seller_snapshot)}catch(e){return null}})() : null, charges: type==="tax_invoice" && r.charges ? (()=>{try{return JSON.parse(r.charges)}catch(e){return []}})() : [], orderSnapshot: r.order_snapshot ? (()=>{try{return JSON.parse(r.order_snapshot)}catch(e){return null}})() : null });
      const mapClient = (r) => ({ id:r.id, name:r.name, gstin:r.gstin||"", contact:r.contact||"", email:r.email||"", billingName:r.billing_name||"", billingAddress:r.billing_address||"", billingStateCode:r.billing_state_code||"", placeOfSupply:r.place_of_supply||"", shippingName:r.shipping_name||"", shippingContact:r.shipping_contact||"", shippingGstin:r.shipping_gstin||"", shippingAddress:r.shipping_address||"", shippingStateCode:r.shipping_state_code||"", isDeleted:r.is_deleted||false, clientType:r.client_type||"B2B" });
      const mapExpense = (r) => ({ id:r.id, date:r.date, paidBy:r.paid_by, amount:r.amount, category:r.category||"", comment:r.comment||"", isDeleted:r.is_deleted||false });
      const mapAsset = (r) => ({ id:r.id, name:r.name||"", category:r.category||"", purchaseDate:r.purchase_date||"", amount:r.amount||0, paidBy:r.paid_by||"", vendor:r.vendor||"", description:r.description||"", invoiceUrl:r.invoice_url||"", invoicePublicId:r.invoice_public_id||"", linkedExpenseId:r.linked_expense_id||"", isDeleted:r.is_deleted||false });
      if (emps?.length) setEmployees(emps.filter(r=>!r.is_deleted).map(r=>({id:r.id, name:r.name, role:r.role||"", isDeleted:false})));
      if (qt?.length) setQuotations(qt.map(mapInv("quotation")));
      if (pf?.length) setProformas(pf.map(mapInv("proforma")));
      if (ti?.length) setTaxInvoices(ti.map(mapInv("tax_invoice")));
      if (cl?.length) setClients(cl.map(mapClient).filter(c=>!c.isDeleted));
      if (ass?.length) setAssets(ass.map(mapAsset).filter(a=>!a.isDeleted));
      if (ex?.length) setExpenses(ex.map(mapExpense).filter(e=>!e.isDeleted));
      if (stl?.length) setSettlements(stl.map(r=>({ id:r.id, date:r.date, amount:r.amount, ref:r.ref||"", fromId:r.from_id, via:r.via, direction:r.direction })));
      if (inv?.length) setInventory(inv.map(r=>({ id:r.id, brand:r.brand||"", material:r.material||"PLA", color:r.color||"", weightG:r.weight_g||1000, costTotal:r.cost_total||0, purchaseDate:r.purchase_date||"", notes:r.notes||"", linkedExpenseIds:r.linked_expense_ids||[] })).filter(r=>!r.isDeleted));
      if (prods?.length) setProducts(prods.map(r=>({ id:r.id, name:r.name||"", hsn:r.hsn||"", brand:r.brand||"", material:r.material||"", weightG:Number(r.weight_g)||0, unitPrice:Number(r.unit_price)||0, productType:r.product_type||"3d_printed", cgstRate:Number(r.cgst_rate)||9, sgstRate:Number(r.sgst_rate)||9, notes:r.notes||"" })));
      if (wlog?.length) setWastageLog(wlog.map(r=>({ id:r.id, date:r.date, brand:r.brand||"", material:r.material||"", color:r.color||"", weightG:r.weight_g||0, reason:r.reason||"", orderNo:r.order_no||"", notes:r.notes||"", groupKey:r.group_key||"" })));
    }).catch((e)=>{ console.error("Phase 2 load error:", e); });
    }).catch((e)=>{ console.error("Phase 1 load error:", e); setLoading(false); });
    })(); // end async IIFE
  },[accessToken]);

  // ── Queue-based sync ────────────────────────────────────────────────────
  const flushQueue = useCallback(async ()=>{
    if (syncing.current || syncQueue.current.length===0 || !sb()) return;
    syncing.current = true;
    setSyncStatus("saving");
    const batch = [...syncQueue.current];
    syncQueue.current = [];
    const cu = currentUser;
    const auditUrl = sbUrl2 && sbKey2 && cu ? `${sbUrl2}/rest/v1/app_audit_log` : null;
    const auditToken = sessionStorage.getItem("sb_token")||sbKey2;
    const auditHeaders = auditUrl ? {"apikey":sbKey2,"Authorization":`Bearer ${auditToken}`,"Content-Type":"application/json","Prefer":"return=minimal"} : null;
    const logAudit = (action, table, recId, detail) => {
      if (!auditUrl) return;
      const entry = {id:crypto.randomUUID(),user_id:cu.id||"admin",username:cu.username||"admin",action,tab:"",record_id:String(recId||"").slice(0,100),detail:String(detail||"").slice(0,200),ts:new Date().toISOString()};
      fetch(auditUrl,{method:"POST",headers:auditHeaders,body:JSON.stringify(entry)}).catch(()=>{});
    };
    const errors = [];
    try {
      for (const job of batch) {
        try {
          if (job.action==="upsert") {
            const res = await sb().from(job.table).upsert(job.row);
            if (res?.error) throw res.error;
            if (!["app_audit_log","app_sessions"].includes(job.table)) {
              const recId = job.row?.order_no||job.row?.id||job.row?.inv_no||job.row?.key||"";
              logAudit("upsert", job.table, recId, `${job.table}: ${recId}`);
            }
          } else if (job.action==="delete") {
            const res = await sb().from(job.table).delete(job.col, job.val);
            if (res?.error) throw res.error;
            logAudit("delete", job.table, job.val, `${job.table}: ${job.val}`);
          } else if (job.action==="deleteMany") {
            const res = await sb().from(job.table).deleteMany(job.col, [job.val]);
            if (res?.error) throw res.error;
          } else if (job.action==="saveSettings") {
            for (const [k,v] of Object.entries(job.data)) {
              const res = await sb().from("settings").upsert({key:k, value: typeof v==="object"?JSON.stringify(v):String(v)});
              if (res?.error) throw res.error;
            }
            logAudit("saveSettings","settings","","settings updated");
          }
        } catch(e) {
          const msg = e?.message||e?.details||String(e);
          const hint = msg.toLowerCase().includes("column")?" (run DB migration)"
            : msg.toLowerCase().includes("permission")||msg.toLowerCase().includes("policy")?" (check Supabase RLS)":"";
          errors.push(`${job.table}/${job.action}: ${msg}${hint}`);
          console.error("[DB Error]",job.table,job.action,e);
        }
      }
      if (errors.length===0) setSyncStatus("saved");
      else { setSyncStatus("error"); toast(`DB save failed: ${errors[0]}`,"error"); console.error("[DB Errors]",errors); }
    } finally {
      syncing.current = false;
      setTimeout(()=>setSyncStatus(""),3000);
      if (syncQueue.current.length>0) flushQueue();
    }
  },[sbUrl, sbKey, currentUser, sbUrl2, sbKey2]);

  const enqueue = useCallback((jobs)=>{
    const list = Array.isArray(jobs)?jobs:[jobs];
    // Security: non-admin users cannot enqueue write ops for tabs they don\'t have write access to
    // We check write permission at the data level using canWrite — permissions come from DB, not client storage
    if (!isAdmin) {
      for (const job of list) {
        if (job.action==="saveSettings" && !canWrite("settings")) {
          toast("Permission denied: Settings","error"); return;
        }
      }
    }
    syncQueue.current.push(...list);
    setTimeout(flushQueue, 600);
  },[flushQueue, isAdmin, canWrite, toast]);

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
      charges:JSON.stringify(o.charges||[]),
      is_pickup:o.isPickup?1:0,
      ...(o.cancelReason?{cancel_reason:o.cancelReason}:{}),
      channel:o.channel||"Offline",
      is_referred:o.isReferred?1:0,
      referral_person:o.referralPerson||"",
      referral_amount:o.referralAmount||0,
      referral_paid:o.referralPaid?1:0,
      referral_paid_date:o.referralPaidDate||"",
      referral_paid_ref:o.referralPaidRef||""
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
    mode:p.mode||"", received_by:p.receivedBy||"", txn_ref:p.txnRef||"", comments:p.comments||"",
    ...(p.isRefund!==undefined?{is_refund:p.isRefund?1:0}:{}),
    ...(p.refundTo?{refund_to:p.refundTo}:{})
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
  const upsertEmployee=(e)=>enqueue({action:"upsert",table:"employees",row:{id:e.id,name:e.name,role:e.role||"",is_deleted:e.isDeleted||false}});
  const deleteEmployee=(e)=>enqueue({action:"delete",table:"employees",col:"id",val:e.id});
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
    const sid = sessionStorage.getItem("app_session_id");
    if (sid && sbUrl2 && sbKey2 && accessToken) { fetch(`${sbUrl2}/rest/v1/app_sessions?id=eq.${sid}`,{method:"PATCH",headers:{"apikey":sbKey2,"Authorization":`Bearer ${accessToken}`,"Content-Type":"application/json","Prefer":"return=minimal"},body:JSON.stringify({logout_at:new Date().toISOString()})}).catch(()=>{}); }
    setAccessToken(""); setUser(null); setCurrentUser(null);
    sessionStorage.removeItem("sb_token"); sessionStorage.removeItem("app_user"); sessionStorage.removeItem("app_session_id"); sessionStorage.removeItem("sb_refresh_token");
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
    setCurrentUser(userData);
    sessionStorage.setItem("sb_token", token);
    // Don't reload — state already set
  };

  // ── Supabase credentials handlers ───────────────────────────────────────
  const handleSetSbUrl=(v)=>{ setSbUrl(v); localStorage.setItem("sb_url",v); };
  const handleSetSbKey=(v)=>{ setSbKey(v); localStorage.setItem("sb_key",v); };

  const TABS=[
    {id:"analytics", label:"Analytics", icon:"📊", group:"orders"},
    {id:"new",     label:"New Order",  icon:"✏️",  group:"orders"},
    {id:"orders",  label:"Orders",     icon:"📋",  group:"orders"},
    {id:"clients", label:"Clients",    icon:"👥",  group:"orders"},
    {id:"expenses",label:"Expenses",   icon:"💸",  group:"finance"},
    {id:"income",  label:"Income",     icon:"📈",  group:"finance"},
    {id:"dashboard",label:"Splitwise", icon:"⚖️", group:"finance"},
    {id:"inventory",label:"Inventory", icon:"🧵",  group:"ops"},
    {id:"products",label:"Products",   icon:"📦",  group:"ops"},
    {id:"assets",  label:"Assets",     icon:"🏗️", group:"ops"},
    {id:"salary",  label:"Salary",     icon:"👷",  group:"ops"},
    {id:"download",label:"Download",   icon:"⬇️", group:"ops"},
    {id:"settings",label:"Settings",   icon:"⚙️", group:"meta"},
    {id:"admin",   label:"Admin",      icon:"🛡️", group:"meta"},
  ];

  if (!accessToken) return <LoginScreen onLogin={handleLogin} sbUrl={sbUrl} sbKey={sbKey}/>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50 font-sans">
      <style>{`input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield}.scrollbar-none::-webkit-scrollbar{display:none}.scrollbar-none{-ms-overflow-style:none;scrollbar-width:none}`}</style>
      <Toast toasts={toasts}/>
      {loading&&<div className="fixed inset-0 z-50 bg-white/80 flex items-center justify-center"><div className="text-center"><div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-3"></div><p className="text-sm font-semibold text-indigo-600">Syncing your data…</p></div></div>}
      {/* ── Sidebar nav (desktop) ── */}
      <div className="hidden md:flex fixed left-0 top-0 h-full w-36 bg-white border-r border-gray-100 shadow-sm flex-col z-20">
        {/* Logo / brand */}
        <div className="flex items-center justify-center h-14 border-b border-gray-100 shrink-0 px-3">
          {seller.logo
            ? <img src={seller.logo} alt="logo" className="h-9 max-w-[100px] object-contain mx-auto"/>
            : <span className="text-xs font-black text-indigo-600 tracking-tight leading-tight text-center">{seller.name||"Elace"}</span>
          }
        </div>
        {/* Tabs */}
        <div className="flex-1 flex flex-col py-3 gap-0.5 overflow-y-auto px-2">
          {TABS.filter(t=>t.id!=="settings"&&(t.id==="admin"?isAdmin:isAdmin||canRead(t.id))).map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)}
              className={`relative w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${tab===t.id?"bg-indigo-50 text-indigo-700":"text-gray-500 hover:bg-gray-50 hover:text-gray-800"}`}>
              {tab===t.id&&<span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-indigo-500 rounded-r"/>}
              <span className="text-sm leading-none shrink-0">{t.icon}</span>
              <span className="truncate">{t.label}</span>
            </button>
          ))}
        </div>
        {/* Bottom: sync status + settings + sign out */}
        <div className="flex flex-col border-t border-gray-100 pt-2 pb-3 px-2 gap-0.5 shrink-0">
          {(syncStatus==="saving"||syncStatus==="error")&&(
            <div className="px-3 py-1">
              {syncStatus==="saving"&&<span className="text-[10px] text-indigo-400 font-semibold animate-pulse">Saving…</span>}
              {syncStatus==="error"&&<span className="text-[10px] text-red-400 font-semibold">Failed to save</span>}
            </div>
          )}
          {(isAdmin||canRead("settings"))&&<button onClick={()=>setTab("settings")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${tab==="settings"?"bg-indigo-50 text-indigo-700":"text-gray-500 hover:bg-gray-50 hover:text-gray-800"}`}>
            <span className="text-sm leading-none shrink-0">⚙️</span>
            <span>Settings</span>
          </button>}
          <button onClick={handleLogout}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-red-500 border border-red-200 hover:bg-red-50 transition-all">
            <span className="text-sm leading-none shrink-0">🚪</span>
            <span>{countdown!==null
              ? <span className="font-black text-amber-600 tabular-nums">{String(Math.floor(countdown/60)).padStart(2,"0")}:{String(countdown%60).padStart(2,"0")}</span>
              : "Sign Out"}</span>
          </button>
        </div>
      </div>

      {/* ── Bottom tab bar (mobile) ── */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 shadow-lg z-20 flex flex-col">
        <div className="flex overflow-x-auto scrollbar-none" style={{WebkitOverflowScrolling:"touch"}}>
          {TABS.filter(t=>t.id!=="settings"&&(t.id==="admin"?isAdmin:isAdmin||canRead(t.id))).map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)}
              className={`shrink-0 flex flex-col items-center justify-center py-2 px-3 gap-0.5 min-w-[56px] relative transition-all ${tab===t.id?"text-indigo-600":"text-gray-400"}`}>
              {tab===t.id&&<span className="absolute top-0 inset-x-2 h-0.5 bg-indigo-500 rounded-full"/>}
              <span className="text-lg leading-none">{t.icon}</span>
              <span className="text-[9px] font-semibold leading-tight mt-0.5 whitespace-nowrap">{t.label.split(" ")[0]}</span>
            </button>
          ))}
        </div>
        {/* Settings + Sign Out row always visible */}
        <div className="flex border-t border-gray-100">
          {(isAdmin||canRead("settings"))&&<button onClick={()=>setTab("settings")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-all ${tab==="settings"?"text-indigo-600":"text-gray-500"}`}>
            <span>⚙️</span><span>Settings</span>
          </button>}
          <button onClick={handleLogout}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold text-red-500">
            <span>🚪</span>
            <span>{countdown!==null
              ?<span className="font-black text-amber-600 tabular-nums">{String(Math.floor(countdown/60)).padStart(2,"0")}:{String(countdown%60).padStart(2,"0")}</span>
              :"Sign Out"}</span>
          </button>
        </div>
      </div>

      {/* ── Main content area ── */}
      <div className="md:pl-36 pb-36 md:pb-0">
      <div className="px-3 md:px-6 py-4 md:py-6">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 md:p-8">
          {!hasAnyAccess&&!isAdmin&&(
            <div className="flex flex-col items-center justify-center h-[70vh] gap-4 text-center px-8">
              <div className="text-6xl">🔒</div>
              <h2 className="text-xl font-black text-slate-700">No Access Yet</h2>
              <p className="text-sm text-gray-400 max-w-xs">You don't have permission to access any section. Please contact your admin to grant you access.</p>
            </div>
          )}
          {hasAnyAccess&&tab==="analytics"&&canRead("analytics")&&<AnalyticsDashboard orders={orders} expenses={expenses} inventory={inventory} wastageLog={wastageLog} taxInvoices={taxInvoices} quotations={quotations} subTabPerms={isAdmin?null:(typeof perms["analytics"]==="object"&&perms["analytics"]!==null?perms["analytics"]:null)}/>}
          {hasAnyAccess&&tab==="new"&&canWrite("new")&&<OrderForm orders={orders} setOrders={syncSetOrders} quotations={quotations} setQuotations={syncSetQuotations} proformas={proformas} setProformas={syncSetProformas} taxInvoices={taxInvoices} setTaxInvoices={syncSetTaxInvoices} seller={seller} series={series} clients={clients} recipients={recipients} onViewOrder={(o)=>{setViewOrder(o);setTab("orders");}} toast={toast} products={products} inventory={inventory} wastageLog={wastageLog}/>}
          {hasAnyAccess&&tab==="orders"&&canRead("orders")&&<OrdersList readOnly={!canWrite("orders")} subTabPerms={isAdmin?null:(typeof perms["orders"]==="object"&&perms["orders"]!==null?perms["orders"]:null)} orders={orders} setOrders={syncSetOrders} quotations={quotations} setQuotations={syncSetQuotations} proformas={proformas} setProformas={syncSetProformas} taxInvoices={taxInvoices} setTaxInvoices={syncSetTaxInvoices} seller={seller} series={series} recipients={recipients} allRecipients={allRecipientsRef.current} upsertPayment={upsertPayment} enqueue={enqueue} initialOrder={viewOrder} onClearInitialOrder={()=>setViewOrder(null)} toast={toast} inventory={inventory} wastageLog={wastageLog} setWastageLog={syncSetWastageLog} products={products} expenses={expenses} setExpenses={syncSetExpenses}/>}
          {hasAnyAccess&&tab==="clients"&&canRead("clients")&&<ClientMaster readOnly={!canWrite("clients")} clients={clients} setClients={syncSetClients} deleteClient={deleteClient} toast={toast}/>}
          {hasAnyAccess&&tab==="expenses"&&canRead("expenses")&&<ExpenseTracker readOnly={!canWrite("expenses")} subTabPerms={isAdmin?null:(typeof perms["expenses"]==="object"&&perms["expenses"]!==null?perms["expenses"]:null)} expenses={expenses} setExpenses={syncSetExpenses} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller} deleteExpense={deleteExpense} toast={toast}/>}
          {hasAnyAccess&&tab==="assets"&&canRead("assets")&&<AssetManager readOnly={!canWrite("assets")} assets={assets} setAssets={syncSetAssets} deleteAsset={deleteAsset} expenses={expenses} setExpenses={syncSetExpenses} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller} cdnCloud={cdnCloud} cdnPreset={cdnPreset} toast={toast}/>}
          {hasAnyAccess&&tab==="products"&&canRead("products")&&<ProductManager readOnly={!canWrite("products")} products={products} setProducts={syncSetProducts} seller={seller} toast={toast} inventory={inventory}/>}
          {hasAnyAccess&&tab==="inventory"&&canRead("inventory")&&<InventoryManager readOnly={!canWrite("inventory")} inventory={inventory} setInventory={syncSetInventory} expenses={expenses} setExpenses={syncSetExpenses} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller} setSeller={syncSetSeller} deleteInventoryItem={deleteInventoryItem} toast={toast} orders={orders} wastageLog={wastageLog} setWastageLog={syncSetWastageLog}/>}
          {hasAnyAccess&&tab==="income"&&canRead("income")&&<IncomeView orders={orders} quotations={quotations} taxInvoices={taxInvoices} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller} subTabPerms={isAdmin?null:(typeof perms["income"]==="object"&&perms["income"]!==null?perms["income"]:null)}/>}
          {hasAnyAccess&&tab==="salary"&&canRead("salary")&&<SalaryManager readOnly={!canWrite("salary")} employees={employees} setEmployees={setEmployees} expenses={expenses} setExpenses={syncSetExpenses} upsertEmployee={upsertEmployee} deleteEmployee={deleteEmployee} deleteExpense={deleteExpense} toast={toast}/>}
          {hasAnyAccess&&tab==="download"&&canRead("download")&&<BulkDownload orders={orders} quotations={quotations} proformas={proformas} taxInvoices={taxInvoices} seller={seller} expenses={expenses} subTabPerms={isAdmin?null:(typeof perms["download"]==="object"&&perms["download"]!==null?perms["download"]:null)}/>}
          {hasAnyAccess&&tab==="dashboard"&&canRead("dashboard")&&<Dashboard orders={orders} expenses={expenses} recipients={recipients} allRecipients={allRecipientsRef.current} seller={seller} settlements={settlements} setSettlements={syncSetSettlements} readOnly={!canWrite("dashboard")}/>}
          {hasAnyAccess&&tab==="settings"&&canRead("settings")&&canRead("settings")&&<Settings sbUrl={sbUrl} setSbUrl={handleSetSbUrl} sbKey={sbKey} setSbKey={handleSetSbKey} seller={seller} setSeller={syncSetSeller} series={series} setSeries={syncSetSeries} recipients={recipients} setRecipients={syncSetRecipients} upsertRecipient={upsertRecipient} allRecipients={allRecipientsRef.current} toast={toast} syncStatus={syncStatus}/>}
          {hasAnyAccess&&tab==="admin"&&canRead("admin")&&isAdmin&&<AdminPanel sbUrl={sbUrl2} sbKey={sbKey2} accessToken={accessToken} toast={toast} currentUser={currentUser}/>}
        </div>
      </div>
      </div>
    </div>
  );
}

export default App;
