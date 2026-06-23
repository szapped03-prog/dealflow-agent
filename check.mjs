// check.mjs — DealFlow watchdog / dead-man's-switch.
//
// Runs INDEPENDENTLY of the agent (GitHub Actions, not Railway) so it can catch
// the agent being dead. Reads the heartbeat the agent writes to Supabase STORAGE
// (no DB table / SQL needed); if it's older than HEARTBEAT_THRESHOLD_MIN, emails
// you "agent is DOWN". Emits one alert per outage and one when it recovers.
//
//   node check.mjs

import { readFileSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

setDefaultResultOrder("ipv4first"); // avoid IPv6 ENETUNREACH on some hosts

// tiny .env loader (no dep) — harmless on CI where env is already set.
try {
  for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* rely on real environment */ }

const THRESHOLD_MIN = Number(process.env.HEARTBEAT_THRESHOLD_MIN || 15);
const BUCKET = "deal-documents";
const HEARTBEAT = "_status/heartbeat.json";
const STATE = "_status/watchdog.json";
const DASH = "https://railway.app/dashboard";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let _mailer;
async function sendAlert(subject, body) {
  const to = process.env.ALERT_EMAIL || process.env.GMAIL_USER;
  if (!to) { console.error("No ALERT_EMAIL/GMAIL_USER set — cannot send alert"); return; }
  _mailer ??= nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true, family: 4,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await _mailer.sendMail({ from: process.env.GMAIL_USER, to, subject: `[DealFlow alert] ${subject}`, text: body });
  console.log("🔔 alert sent: " + subject);
}

async function readJson(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
}
async function writeJson(path, obj) {
  await supabase.storage.from(BUCKET).upload(path, Buffer.from(JSON.stringify(obj)), {
    upsert: true, contentType: "application/json",
  });
}

const hb = await readJson(HEARTBEAT);
const last = hb && hb.at ? new Date(hb.at) : null;
const ageMin = last ? (Date.now() - last.getTime()) / 60000 : Infinity;
const isDown = ageMin > THRESHOLD_MIN;

const state = (await readJson(STATE)) || { down_alerted: false };

if (isDown && !state.down_alerted) {
  await sendAlert(
    "⚠️ DealFlow agent is DOWN",
    `The email agent hasn't completed a check in ${Number.isFinite(ageMin) ? Math.round(ageMin) + " minutes" : "a long time"} ` +
      `(alert threshold ${THRESHOLD_MIN} min).\n` +
      `Last run: ${last ? last.toISOString() : "never / heartbeat missing"}.\n\n` +
      `New deals/invoices are NOT being imported. Check the Railway worker:\n${DASH}`
  );
  await writeJson(STATE, { down_alerted: true, since: new Date().toISOString() });
} else if (!isDown && state.down_alerted) {
  await sendAlert(
    "✅ DealFlow agent recovered",
    `The agent is checking email again (last run ${Math.round(ageMin)} min ago). Imports have resumed.`
  );
  await writeJson(STATE, { down_alerted: false });
  console.log("recovered — cleared alert flag");
} else {
  console.log(`OK — agent last ran ${Number.isFinite(ageMin) ? Math.round(ageMin) + " min ago" : "never"} (down=${isDown}, alerted=${state.down_alerted})`);
}
