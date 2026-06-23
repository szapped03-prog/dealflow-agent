// Daily INVOICE summary: invoice-inbox backlog, new invoices, what's owed by
// vendor, and recurring/overdue/spike flags. Runs daily from GitHub Actions
// (invoice-digest.yml). DRY_RUN=1 prints only.
import { readFileSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { createClient } from "@supabase/supabase-js";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
setDefaultResultOrder("ipv4first");

try {
  for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const fmt = (n) => "$" + Math.round(n || 0).toLocaleString();
const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// 1) Invoice inbox backlog (dedicated invoice Gmail, if configured)
let unread = null;
const iUser = process.env.INVOICE_GMAIL_USER, iPass = process.env.INVOICE_GMAIL_APP_PASSWORD;
if (iUser && iPass) {
  try {
    const c = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, logger: false, tls: { family: 4 }, auth: { user: iUser, pass: iPass } });
    c.on("error", () => {});
    await c.connect();
    const lock = await c.getMailboxLock("INBOX");
    try { unread = (await c.search({ seen: false }, { uid: true }) || []).length; }
    finally { lock.release(); await c.logout().catch(() => {}); }
  } catch (e) { console.error("invoice inbox check failed: " + e.message); }
}

// 2) Invoice data
const { data: invoices } = await sb.from("invoices").select("vendor_name,invoice_number,amount,status,invoice_date,deal_nickname,created_at,type,source_email_id");
const I = invoices || [];
const owed = I.filter((i) => i.status === "owed");
const owedTotal = owed.reduce((s, i) => s + (i.amount || 0), 0);
const newInv = I.filter((i) => i.created_at && i.created_at > dayAgo);
const paidRecent = I.filter((i) => i.status === "paid" && i.created_at && i.created_at > dayAgo);

// Owed grouped by vendor
const byVendor = {};
for (const i of owed) { const v = (i.vendor_name || "Unknown").trim(); byVendor[v] = byVendor[v] || { n: 0, sum: 0 }; byVendor[v].n++; byVendor[v].sum += i.amount || 0; }
const vendorRows = Object.entries(byVendor).sort((a, b) => b[1].sum - a[1].sum);

// Recurring / overdue / spike flags (mirrors the site's trend logic)
const grp = {};
for (const i of I) { if (!i.vendor_name) continue; (grp[i.vendor_name.trim()] ||= []).push(i); }
const flags = [];
for (const [vendor, list] of Object.entries(grp)) {
  const dated = list.filter((v) => v.invoice_date).sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
  if (dated.length < 2) continue;
  const gaps = [];
  for (let k = 1; k < dated.length; k++) gaps.push((+new Date(dated[k].invoice_date) - +new Date(dated[k - 1].invoice_date)) / 86400000);
  const interval = median(gaps);
  const last = dated[dated.length - 1];
  const expected = +new Date(last.invoice_date) + interval * 86400000;
  const overdueDays = Math.round((Date.now() - expected) / 86400000);
  const amts = dated.map((v) => v.amount).filter((a) => a != null);
  const avg = amts.length ? amts.reduce((a, b) => a + b, 0) / amts.length : null;
  if (avg && last.amount && last.amount > avg * 1.4) flags.push(`  🟠 ${vendor}: last ${fmt(last.amount)} is ${Math.round((last.amount / avg - 1) * 100)}% over avg ${fmt(avg)}`);
  if (overdueDays > 7 && interval >= 20) flags.push(`  🔴 ${vendor}: expected invoice ~${overdueDays}d ago (every ~${Math.round(interval)}d)`);
}

const lines = [];
lines.push(`DealFlow — invoice summary · ${new Date().toLocaleDateString()}`);
lines.push("");
if (iUser) lines.push(`Invoice inbox (${iUser}): ${unread == null ? "(couldn't check)" : unread === 0 ? "✅ all processed" : `⚠️ ${unread} waiting`}`);
else lines.push("Invoice inbox: not configured (invoices arrive via the main inbox)");
lines.push("");
lines.push(`New invoices (24h): ${newInv.length}`);
newInv.slice(0, 12).forEach((i) => lines.push(`  • ${i.vendor_name || "?"}${i.amount ? ` — ${fmt(i.amount)}` : ""}${i.deal_nickname ? ` [${i.deal_nickname}]` : ""}`));
lines.push("");
lines.push("── Owed ──────────────────────────");
lines.push(`${owed.length} invoice(s) · ${fmt(owedTotal)}`);
vendorRows.slice(0, 12).forEach(([v, x]) => lines.push(`  • ${v}: ${fmt(x.sum)}${x.n > 1 ? ` (${x.n})` : ""}`));
lines.push("");
lines.push("── Flags ─────────────────────────");
if (flags.length) flags.slice(0, 12).forEach((f) => lines.push(f));
else lines.push("  ✅ nothing recurring overdue or spiking");
lines.push("");
lines.push(`Marked paid (24h): ${paidRecent.length}`);
lines.push("");
lines.push("Open → https://dealflow-self-eight.vercel.app/invoices");
const body = lines.join("\n");
console.log(body);

const to = process.env.ALERT_EMAIL || process.env.GMAIL_USER;
if (to && !process.env.DRY_RUN) {
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, family: 4, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  await t.sendMail({ from: process.env.GMAIL_USER, to, subject: `[DealFlow] Invoice summary — ${fmt(owedTotal)} owed`, text: body });
  console.log(`\nsent to ${to}`);
}
