// Hourly status email: a quick pulse so you always know the system is alive and
// what moved in the last hour. Runs from GitHub Actions (status.yml, hourly).
// DRY_RUN=1 prints only.
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
const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
const BUCKET = "deal-documents";

// 1) Agent heartbeat (storage) — is the worker alive?
let hbAgeMin = Infinity;
try {
  const { data } = await sb.storage.from(BUCKET).download("_status/heartbeat.json");
  if (data) { const hb = JSON.parse(await data.text()); if (hb.at) hbAgeMin = (Date.now() - new Date(hb.at).getTime()) / 60000; }
} catch {}
const agentOk = hbAgeMin <= 10;

// 2) Inbox backlog — how many emails are waiting to be processed?
let unread = null;
try {
  const c = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, logger: false, tls: { family: 4 },
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  c.on("error", () => {});
  await c.connect();
  const lock = await c.getMailboxLock("INBOX");
  try { unread = (await c.search({ seen: false }, { uid: true }) || []).length; }
  finally { lock.release(); await c.logout().catch(() => {}); }
} catch (e) { console.error("inbox check failed: " + e.message); }

// 3) Pipeline + invoice snapshot
const { data: deals } = await sb.from("deals").select("nickname,status,stage,asking_price,needs_review,created_at");
const { data: invoices } = await sb.from("invoices").select("amount,status,created_at");
const D = deals || [], I = invoices || [];
const active = D.filter((d) => d.status === "pipeline" && ["sourcing", "loi", "under_contract", "due_diligence"].includes(d.stage));
const owned = D.filter((d) => d.status === "owned");
const newDeals = D.filter((d) => d.created_at && d.created_at > hourAgo);
const newInv = I.filter((i) => i.created_at && i.created_at > hourAgo);
const flagged = D.filter((d) => d.needs_review);
const pipeValue = active.reduce((s, d) => s + (d.asking_price || 0), 0);
const owed = I.filter((i) => i.status === "owed");
const owedTotal = owed.reduce((s, i) => s + (i.amount || 0), 0);

// Flag anything that needs a human's eye in the subject line.
const issues = [];
if (!agentOk) issues.push("agent may be down");
if (unread && unread > 0) issues.push(`${unread} unprocessed`);
const ok = issues.length === 0;
const subject = `[DealFlow] ${ok ? "✅ OK" : "⚠️ " + issues.join(", ")} — ${newDeals.length} new this hour`;

const lines = [];
lines.push(`DealFlow status · ${new Date().toLocaleString()}`);
lines.push("");
lines.push(`Agent: ${agentOk ? `✅ running (last check ${Math.round(hbAgeMin)} min ago)` : `⚠️ NO heartbeat in ${Number.isFinite(hbAgeMin) ? Math.round(hbAgeMin) + " min" : "a long time"} — check Railway`}`);
lines.push(`Inbox: ${unread == null ? "(couldn't check)" : unread === 0 ? "✅ all processed (0 waiting)" : `⚠️ ${unread} email(s) waiting`}`);
lines.push("");
lines.push(`Last hour: +${newDeals.length} deal(s), +${newInv.length} invoice(s)`);
newDeals.slice(0, 8).forEach((d) => lines.push(`  • ${d.nickname}${d.asking_price ? ` — ${fmt(d.asking_price)}` : ""}`));
lines.push("");
lines.push(`Pipeline: ${active.length} active · ${fmt(pipeValue)}`);
lines.push(`Owned: ${owned.length}`);
lines.push(`Flagged for review: ${flagged.length}`);
lines.push(`Invoices owed: ${owed.length} · ${fmt(owedTotal)}`);
lines.push("");
lines.push("Open → https://dealflow-self-eight.vercel.app");
const body = lines.join("\n");
console.log(subject + "\n\n" + body);

const to = process.env.ALERT_EMAIL || process.env.GMAIL_USER;
if (to && !process.env.DRY_RUN) {
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, family: 4, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  await t.sendMail({ from: process.env.GMAIL_USER, to, subject, text: body });
  console.log(`\nsent to ${to}`);
}
