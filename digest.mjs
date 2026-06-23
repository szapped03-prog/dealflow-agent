// Daily summary: a full "what's going on" recap — agent health, pipeline, the
// last 24h of activity/progress, the owned portfolio, and invoices. Runs once a
// day from GitHub Actions (digest.yml, ~9am ET). DRY_RUN=1 prints only.
import { readFileSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { createClient } from "@supabase/supabase-js";
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
const BUCKET = "deal-documents";

// Agent health (storage heartbeat)
let hbAgeMin = Infinity;
try {
  const { data } = await sb.storage.from(BUCKET).download("_status/heartbeat.json");
  if (data) { const hb = JSON.parse(await data.text()); if (hb.at) hbAgeMin = (Date.now() - new Date(hb.at).getTime()) / 60000; }
} catch {}

const { data: deals } = await sb.from("deals").select("nickname,status,stage,asking_price,current_value,annual_noi,needs_review,created_at,updates,last_email_summary,last_email_at");
const { data: invoices } = await sb.from("invoices").select("vendor_name,amount,status,created_at");

const D = deals || [], I = invoices || [];
const STAGE_LABEL = { sourcing: "Sourcing", loi: "LOI", under_contract: "Under contract", due_diligence: "Due diligence", closed: "Closed", dead: "Dead" };
const active = D.filter((d) => d.status === "pipeline" && ["sourcing", "loi", "under_contract", "due_diligence"].includes(d.stage));
const owned = D.filter((d) => d.status === "owned");
const newDeals = D.filter((d) => d.created_at && d.created_at > dayAgo);
const flagged = D.filter((d) => d.needs_review);
const pipeValue = active.reduce((s, d) => s + (d.asking_price || 0), 0);
const ownedValue = owned.reduce((s, d) => s + (d.current_value || 0), 0);
const ownedNoi = owned.reduce((s, d) => s + (d.annual_noi || 0), 0);
const owed = I.filter((i) => i.status === "owed");
const owedTotal = owed.reduce((s, i) => s + (i.amount || 0), 0);
const newInv = I.filter((i) => i.created_at && i.created_at > dayAgo);

// Activity in the last 24h: status-timeline entries + emails that landed.
const activity = [];
for (const d of D) {
  for (const u of d.updates || []) {
    if (u && u.date && u.date > dayAgo && (u.headline || u.progress)) activity.push(`  • [${d.nickname}] ${u.headline || u.progress}`);
  }
}

const lines = [];
lines.push(`DealFlow — daily summary · ${new Date().toLocaleDateString()}`);
lines.push("");
lines.push(`Agent: ${hbAgeMin <= 90 ? `✅ running (last check ${Math.round(hbAgeMin)} min ago)` : "⚠️ heartbeat stale — check Railway"}`);
lines.push("");
lines.push("── Pipeline ──────────────────────");
lines.push(`${active.length} active deals · ${fmt(pipeValue)}`);
const byStage = {};
active.forEach((d) => { byStage[d.stage] = (byStage[d.stage] || 0) + 1; });
Object.entries(byStage).forEach(([s, n]) => lines.push(`  ${STAGE_LABEL[s] || s}: ${n}`));
lines.push("");
lines.push(`New deals (24h): ${newDeals.length}`);
newDeals.slice(0, 12).forEach((d) => lines.push(`  • ${d.nickname}${d.asking_price ? ` — ${fmt(d.asking_price)}` : ""}`));
lines.push("");
lines.push("── Activity (last 24h) ───────────");
if (activity.length) activity.slice(0, 15).forEach((a) => lines.push(a));
else lines.push("  (no status updates logged)");
lines.push("");
lines.push("── Needs attention ───────────────");
lines.push(`Flagged for review: ${flagged.length}`);
flagged.slice(0, 10).forEach((d) => lines.push(`  ⚠ ${d.nickname}`));
lines.push("");
lines.push("── Portfolio (owned) ─────────────");
lines.push(`${owned.length} properties · value ${fmt(ownedValue)}${ownedNoi ? ` · NOI ${fmt(ownedNoi)}` : ""}`);
lines.push("");
lines.push("── Invoices ──────────────────────");
lines.push(`Owed: ${owed.length} · ${fmt(owedTotal)}`);
lines.push(`New (24h): ${newInv.length}`);
lines.push("");
lines.push("Open → https://dealflow-self-eight.vercel.app");
const body = lines.join("\n");
console.log(body);

const to = process.env.ALERT_EMAIL || process.env.GMAIL_USER;
if (to && !process.env.DRY_RUN) {
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, family: 4, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  await t.sendMail({ from: process.env.GMAIL_USER, to, subject: `[DealFlow] Daily summary — ${new Date().toLocaleDateString()}`, text: body });
  console.log(`\nsent to ${to}`);
}
