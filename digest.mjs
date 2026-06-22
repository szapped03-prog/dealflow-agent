// Daily digest: summarize the pipeline + invoices and email it. Runs once a day
// from its own GitHub Actions schedule (digest.yml). DRY_RUN=1 prints only.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

try {
  for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const fmt = (n) => "$" + Math.round(n || 0).toLocaleString();
const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

const { data: deals } = await sb.from("deals").select("nickname,status,stage,asking_price,needs_review,created_at");
const { data: invoices } = await sb.from("invoices").select("vendor_name,amount,status");

const D = deals || [];
const I = invoices || [];
const active = D.filter((d) => d.status === "pipeline" && ["sourcing", "loi", "under_contract", "due_diligence"].includes(d.stage));
const newDeals = D.filter((d) => d.created_at && d.created_at > dayAgo);
const flagged = D.filter((d) => d.needs_review);
const pipeValue = active.reduce((s, d) => s + (d.asking_price || 0), 0);
const owed = I.filter((i) => i.status === "owed");
const owedTotal = owed.reduce((s, i) => s + (i.amount || 0), 0);

const lines = [];
lines.push(`DealFlow — daily digest · ${new Date().toLocaleDateString()}`);
lines.push("");
lines.push(`Pipeline: ${active.length} active deals · ${fmt(pipeValue)}`);
lines.push(`New in last 24h: ${newDeals.length}`);
newDeals.slice(0, 10).forEach((d) => lines.push(`  • ${d.nickname}${d.asking_price ? ` — ${fmt(d.asking_price)}` : ""}`));
lines.push("");
lines.push(`Flagged for review: ${flagged.length}`);
flagged.slice(0, 10).forEach((d) => lines.push(`  ⚠ ${d.nickname}`));
lines.push("");
lines.push(`Invoices owed: ${owed.length} · ${fmt(owedTotal)}`);
lines.push("");
lines.push("Open → https://dealflow-self-eight.vercel.app");
const body = lines.join("\n");
console.log(body);

const to = process.env.ALERT_EMAIL || process.env.GMAIL_USER;
if (to && !process.env.DRY_RUN) {
  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  await t.sendMail({ from: process.env.GMAIL_USER, to, subject: `[DealFlow] Daily digest — ${new Date().toLocaleDateString()}`, text: body });
  console.log(`\nsent to ${to}`);
}
