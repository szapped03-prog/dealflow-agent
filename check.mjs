// check.mjs — DealFlow watchdog / dead-man's-switch.
//
// Runs INDEPENDENTLY of the agent (GitHub Actions, not Railway) so it can catch
// the agent being dead. Reads the heartbeat the agent writes to Supabase; if it's
// older than HEARTBEAT_THRESHOLD_MIN, emails you "agent is DOWN". Emails once per
// outage (down_alerted flag) and once more when it recovers.
//
//   node check.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

// tiny .env loader (no dep) — harmless on CI where env is already set.
try {
  for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* rely on real environment */ }

const THRESHOLD_MIN = Number(process.env.HEARTBEAT_THRESHOLD_MIN || 15);
const DASH = "https://railway.app/dashboard";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let _mailer;
async function sendAlert(subject, body) {
  const to = process.env.ALERT_EMAIL || process.env.GMAIL_USER;
  if (!to) { console.error("No ALERT_EMAIL/GMAIL_USER set — cannot send alert"); return; }
  _mailer ??= nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await _mailer.sendMail({ from: process.env.GMAIL_USER, to, subject: `[DealFlow alert] ${subject}`, text: body });
  console.log("🔔 alert sent: " + subject);
}

const { data, error } = await supabase
  .from("agent_status")
  .select("last_run_at, down_alerted")
  .eq("id", 1)
  .single();

if (error) {
  console.error("Could not read agent_status:", error.message);
  // A missing/unreadable heartbeat row is itself a problem worth flagging.
  try { await sendAlert("DealFlow watchdog can't read heartbeat", `${error.message}\n\nRun schema_heartbeat.sql in Supabase if you haven't.`); } catch {}
  process.exit(1);
}

const last = data.last_run_at ? new Date(data.last_run_at) : null;
const ageMin = last ? (Date.now() - last.getTime()) / 60000 : Infinity;
const isDown = ageMin > THRESHOLD_MIN;

if (isDown && !data.down_alerted) {
  await sendAlert(
    "⚠️ DealFlow agent is DOWN",
    `The email agent hasn't completed a check in ${Number.isFinite(ageMin) ? Math.round(ageMin) + " minutes" : "a long time"} ` +
      `(alert threshold ${THRESHOLD_MIN} min).\n` +
      `Last run: ${last ? last.toISOString() : "never"}.\n\n` +
      `New deals/invoices are NOT being imported. Check the Railway worker:\n${DASH}`
  );
  await supabase.from("agent_status").update({ down_alerted: true }).eq("id", 1);
} else if (!isDown && data.down_alerted) {
  await sendAlert(
    "✅ DealFlow agent recovered",
    `The agent is checking email again (last run ${Math.round(ageMin)} min ago). Imports have resumed.`
  );
  await supabase.from("agent_status").update({ down_alerted: false }).eq("id", 1);
  console.log("recovered — cleared alert flag");
} else {
  console.log(`OK — agent last ran ${Number.isFinite(ageMin) ? Math.round(ageMin) + " min ago" : "never"} (down=${isDown}, alerted=${data.down_alerted})`);
}
