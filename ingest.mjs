// ingest.mjs — the DealFlow email agent.
//
//   shared Gmail inbox  →  Claude extraction  →  Supabase `deals` table
//
// Idempotent: every email's Message-ID is stored on the row it created, so
// re-running never double-inserts. Processed mail is marked \Seen.
//
//   node ingest.mjs            # live
//   DRY_RUN=1 node ingest.mjs  # extract + print, write nothing, mark nothing

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import { extractDeal, findComps } from "./extract.mjs";

// Railway's containers have broken IPv6. Node otherwise tries Gmail's IPv6
// address first and hits ENETUNREACH — which is exactly why the mark-as-read
// reconnect and reply emails were intermittently failing. Force IPv4 everywhere.
setDefaultResultOrder("ipv4first");

// ── tiny .env loader (no dependency) ─────────────────────────────────────────
try {
  for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env file — rely on real environment */
}

const DRY_RUN = !!process.env.DRY_RUN;
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const CONFIDENCE_FLOOR = 0.45; // below this we still insert, but flag for review

// Detect errors that mean the whole run is broken (out of API credit, bad keys)
// rather than one bad email — so we can alert instead of silently failing forever.
let fatalAlerted = false;
const isFatalApi = (msg) => /credit balance|billing|authentication|x-api-key|api key|insufficient/i.test(msg || "");

// Text alerts via Twilio when a new deal lands. Needs TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN, TWILIO_FROM (your Twilio number, E.164) and SMS_TO (your
// phone, E.164 e.g. +13053191776). Silently no-ops if any are unset.
const SMS_TO = process.env.SMS_TO || "";
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";
async function textNewDeal(label, address, price) {
  if (DRY_RUN || !SMS_TO || !TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return;
  const body =
    `New deal: ${label}` +
    (address ? ` — ${address}` : "") +
    (price ? ` — $${Number(price).toLocaleString()}` : "");
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: SMS_TO, From: TWILIO_FROM, Body: body }),
    });
    if (!res.ok) { console.error(`  text alert failed: ${res.status} ${(await res.text()).slice(0, 200)}`); return; }
    console.log("  texted alert: " + body);
  } catch (e) {
    console.error("  text alert failed: " + e.message);
  }
}

const required = ["ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GMAIL_USER", "GMAIL_APP_PASSWORD"];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Missing required env var: ${k}  (copy .env.example to .env and fill it in)`);
    process.exit(1);
  }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Reply to the person who forwarded the email, confirming the deal was logged.
// Threaded (In-Reply-To) so it lands in the same conversation. No-op on dry runs
// or when there's no sender address.
let _mailer;
async function sendReply(email, info) {
  if (DRY_RUN || !email.fromAddress) return;
  try {
    _mailer ??= nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      family: 4,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    const subject = /^re:/i.test(email.subject || "") ? email.subject : `Re: ${email.subject || "Deal"}`;
    const price = info.asking_price ? ` — $${Number(info.asking_price).toLocaleString()}` : "";
    const body = [
      `✅ ${info.action} to DealFlow: ${info.nickname}`,
      info.address || null,
      price ? `Asking${price}` : null,
      "",
      info.summary || "",
      "",
      "View pipeline → https://dealflow-self-eight.vercel.app/pipeline",
      "",
      "— DealFlow",
    ]
      .filter((l) => l !== null)
      .join("\n");
    await _mailer.sendMail({
      from: process.env.GMAIL_USER,
      to: email.fromAddress,
      subject,
      inReplyTo: email.messageId,
      references: email.messageId,
      text: body,
    });
    console.log("  ↩ replied to " + email.fromAddress);
  } catch (e) {
    console.error("  reply failed: " + e.message);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

// A STABLE per-email id for dedupe + source_email_id. Prefer the real Message-ID;
// if the email has none, hash its content (sender/date/subject/body) so the SAME
// email always yields the SAME id across runs. (The old uid-based fallback was
// unstable — IMAP UIDs can change — which could double-insert or mis-dedupe.)
const stableId = (parsed) =>
  parsed.messageId ||
  "sha-" +
    createHash("sha1")
      .update(`${parsed.from?.text || ""}|${(parsed.date && parsed.date.toISOString && parsed.date.toISOString()) || parsed.date || ""}|${parsed.subject || ""}|${(parsed.text || "").slice(0, 800)}`)
      .digest("hex")
      .slice(0, 24) + "@dealflow.local";

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Merge two jsonb arrays, de-duplicating by serialized value.
const mergeArrays = (existing, incoming) => {
  const seen = new Set();
  const out = [];
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const k = JSON.stringify(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
};

// Track of an existing deal row (default acquisition for legacy rows).
const trackOf = (d) => d.track || "acquisition";
// Where a freshly-routed deal starts in each pipeline.
const TRACK_START = { acquisition: "sourcing", refi: "refi_evaluating", disposition: "sell_prep" };

// Decide how an extracted deal relates to what's already in the pipeline. Only
// matches within the SAME track, so a refi email never overwrites the
// acquisition record for the same building (they're separate processes).
// Returns { kind: 'update'|'insert', target?, flag? }.
function matchDeal(extracted, deals, track) {
  const exAddr = norm(extracted.address);
  const exNick = norm(extracted.nickname);
  const pool = deals.filter((d) => trackOf(d) === track);

  // Confident match: identical normalized address, or identical nickname.
  const strong = pool.find(
    (d) => (exAddr && norm(d.address) === exAddr) || (exNick && norm(d.nickname) === exNick)
  );
  if (strong) return { kind: "update", target: strong };

  // Loose match: share the street number + at least one other word. Ambiguous →
  // insert but flag for a human, rather than risk corrupting the wrong deal.
  if (exAddr) {
    const exTokens = new Set(exAddr.split(" "));
    const exNum = [...exTokens].find((t) => /^\d+$/.test(t));
    const loose = pool.filter((d) => {
      const dTokens = new Set(norm(d.address).split(" "));
      if (exNum && !dTokens.has(exNum)) return false;
      const overlap = [...exTokens].filter((t) => dTokens.has(t)).length;
      return overlap >= 2;
    });
    if (loose.length) {
      const refs = loose.map((d) => `${d.nickname} (${d.id.slice(0, 8)})`).join("; ");
      return { kind: "insert", flag: `possible duplicate of: ${refs}` };
    }
  }
  return { kind: "insert" };
}

function noteLine(email, extracted) {
  const d = (email.date || "").slice(0, 10);
  return `[${d} · from ${email.from}] ${extracted.summary}`.trim();
}

// ── attachments ───────────────────────────────────────────────────────────────
const BUCKET = "deal-documents"; // private; the site generates signed links on click
const safePath = (s) => (s || "file").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);

// Upload each email attachment to private storage; return document records that
// carry the storage `path` (not a public URL). The site signs a temporary link
// for a logged-in user when they click the document.
async function uploadAttachments(email) {
  const docs = [];
  const folder = safePath(email.messageId);
  for (const a of email.attachmentFiles || []) {
    if (!a.content) continue;
    const path = `${folder}/${safePath(a.filename)}`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, a.content, { contentType: a.contentType || "application/octet-stream", upsert: true });
    if (error) {
      console.error(`  attachment upload failed (${a.filename}): ${error.message}`);
      continue;
    }
    docs.push({ name: a.filename, type: a.contentType || "attachment", path, note: "email attachment" });
    console.log(`  ↑ stored attachment: ${a.filename}`);
  }
  return docs;
}

// Pull a Google Street View photo of the building. To avoid the "wrong picture"
// problem (loose address match + camera pointing the wrong way) we: (1) geocode
// the address to exact coordinates, (2) find the nearest street panorama, and
// (3) point the camera FROM the panorama TOWARD the building. Returns null if we
// can't confidently place it (better no photo than a wrong one).
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || "";

// Free, keyless geocode (server-side, so no CORS). US-biased.
async function geocodeAddress(address) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`,
      { headers: { "User-Agent": "DealFlow/1.0 (SMA Equities)", "Accept-Language": "en" } }
    );
    const d = await r.json();
    if (Array.isArray(d) && d[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) };
  } catch { /* fall through */ }
  return null;
}

// Compass bearing (deg) from point a to point b.
function bearingDeg(a, b) {
  const toR = (x) => (x * Math.PI) / 180;
  const φ1 = toR(a.lat), φ2 = toR(b.lat), Δλ = toR(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

async function fetchBuildingPhoto(address, folderKey) {
  if (!GOOGLE_MAPS_KEY || !address) return null;
  try {
    const geo = await geocodeAddress(address);
    // Query Street View by precise coords when we have them, else the raw address.
    const loc = geo ? `${geo.lat},${geo.lng}` : address;
    const meta = await fetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${encodeURIComponent(loc)}&source=outdoor&key=${GOOGLE_MAPS_KEY}`
    ).then((r) => r.json());
    if (meta.status !== "OK") return null; // no usable street imagery → no photo

    // Aim the camera from the panorama toward the building so we see the right one.
    let aim = "";
    if (geo && meta.location && Number.isFinite(meta.location.lat)) {
      aim = `&heading=${bearingDeg(meta.location, geo)}&pitch=10`;
    }
    const img = await fetch(
      `https://maps.googleapis.com/maps/api/streetview?size=640x640&location=${encodeURIComponent(loc)}&fov=72${aim}&source=outdoor&key=${GOOGLE_MAPS_KEY}`
    );
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    const path = `${safePath(folderKey)}/streetview.jpg`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: "image/jpeg", upsert: true });
    if (error) { console.error(`  street view upload failed: ${error.message}`); return null; }
    console.log(`  📷 added Street View photo${geo ? " (aimed at building)" : ""}`);
    return { path, name: "Street View" };
  } catch (e) {
    console.error(`  street view failed: ${e.message}`);
    return null;
  }
}

// Build the comps record: any comps in the email/OM PLUS comps the bot finds by
// searching the web. Null if neither turns up anything.
async function buildComps(extracted) {
  const om = extracted.comps || [];
  let web = [];
  try {
    web = await findComps(extracted);
  } catch (e) {
    console.error("  comp search failed: " + e.message);
  }
  const items = [...om, ...web];
  if (!items.length) return null;
  console.log(`  📊 comps: ${om.length} from materials + ${web.length} found online`);
  return { source: web.length ? "materials + web" : "materials", fetched_at: new Date().toISOString(), items };
}

// ── write paths ───────────────────────────────────────────────────────────────
const isImage = (d) => (d?.type || "").startsWith("image/"); // route image attachments to photos

// Build a project-status timeline entry from the email, or null if it reports no
// real progress (a plain new-deal intro shouldn't clutter the status log).
function buildUpdate(email, extracted) {
  const su = extracted.status_update;
  if (!su) return null;
  if (!su.has_update && !su.progress && !su.delays && !su.tenants) return null;
  return {
    date: email.date,
    from: email.from,
    headline: su.headline || extracted.summary || null,
    progress: su.progress || null,
    delays: su.delays || null,
    tenants: su.tenants || null,
  };
}

// Combine the model's mentioned documents with the actually-uploaded files,
// dropping a mentioned doc when an uploaded file has the same name (the uploaded
// one wins — it carries the openable storage path). Avoids double-listing.
function mergeDocs(extractedDocs, uploaded) {
  const names = new Set(uploaded.map((d) => (d.name || "").toLowerCase()));
  const mentioned = (extractedDocs || []).filter((d) => !names.has((d.name || "").toLowerCase()));
  return mergeArrays(mentioned, uploaded);
}

async function applyInsert(email, extracted, flag, track, deals) {
  const conf = typeof extracted.confidence === "number" ? extracted.confidence : 0.5;
  const flagged = !!flag || conf < CONFIDENCE_FLOOR;
  const noteParts = [];
  if (flag) noteParts.push(`[NEEDS REVIEW: ${flag}]`);
  if (conf < CONFIDENCE_FLOOR)
    noteParts.push(`[LOW CONFIDENCE ${conf.toFixed(2)}]`);
  noteParts.push(noteLine(email, extracted));

  const emailPhotos = (email.uploadedDocs || []).filter(isImage).map((d) => ({ path: d.path, name: d.name }));
  const streetPhoto = await fetchBuildingPhoto(extracted.address, email.messageId);
  const photos = [...emailPhotos, ...(streetPhoto ? [streetPhoto] : [])];
  const update = buildUpdate(email, extracted);
  const comps = await buildComps(extracted);

  // For a refi/disposition email, link it back to the owned property it's about
  // (so it shows as that asset's process), and start it in that track's stage.
  let sourceDealId = null;
  if (track !== "acquisition" && extracted.address) {
    const ex = norm(extracted.address);
    const owned = (deals || []).find((d) => norm(d.address) === ex && (d.status === "owned" || trackOf(d) === "acquisition"));
    if (owned) sourceDealId = owned.id;
  }
  const stage = track === "acquisition" ? (extracted.stage || "sourcing") : TRACK_START[track];

  const row = {
    status: "pipeline",
    track,
    source_deal_id: sourceDealId,
    nickname: extracted.nickname || email.subject?.slice(0, 60) || "Untitled deal",
    address: extracted.address,
    asset_type: extracted.asset_type,
    submarket: extracted.submarket,
    units: extracted.units,
    asking_price: extracted.asking_price,
    stage,
    broker: extracted.broker,
    firm: extracted.firm,
    next_step: extracted.next_step,
    notes: noteParts.join("\n"),
    contacts: extracted.contacts || [],
    key_dates: extracted.key_dates || [],
    documents: mergeDocs(extracted.documents, (email.uploadedDocs || []).filter((d) => !isImage(d))),
    photos,
    updates: update ? [update] : [],
    comps,
    links: extracted.links || [],
    source_email_id: email.messageId,
    source_from: email.from,
    needs_review: flagged,
    owner_email: email.fromAddress || email.from,
    last_email_summary: extracted.summary,
    last_email_at: email.date,
    last_email_from: email.from,
  };

  if (DRY_RUN) {
    console.log(`  DRY: would INSERT "${row.nickname}"${flagged ? " (flagged)" : ""}`);
    return null;
  }
  const { data, error } = await supabase.from("deals").insert(row).select("id").single();
  if (error) throw error;
  console.log(`  INSERT "${row.nickname}"${flagged ? " (flagged for review)" : ""}`);
  await textNewDeal(row.nickname, row.address, row.asking_price);
  await sendReply(email, { action: "Added", nickname: row.nickname, address: row.address, asking_price: row.asking_price, summary: extracted.summary });
  // Return the row (with id) so the caller can add it to the in-memory snapshot,
  // preventing a second email about the same property in this batch from inserting
  // a duplicate (matchDeal would otherwise not see this brand-new row).
  return { ...row, id: data.id };
}

async function applyUpdate(email, extracted, target) {
  // Only overwrite a field when the email confidently provides a value; always
  // append context to notes and merge the list fields.
  const patch = { source_email_id: email.messageId, source_from: email.from };
  const setIf = (col, val) => {
    if (val !== null && val !== undefined && val !== "") patch[col] = val;
  };
  setIf("address", extracted.address);
  setIf("asset_type", extracted.asset_type);
  setIf("submarket", extracted.submarket);
  setIf("units", extracted.units);
  setIf("asking_price", extracted.asking_price);
  setIf("broker", extracted.broker);
  setIf("firm", extracted.firm);
  setIf("next_step", extracted.next_step);
  // Stage only advances on an explicit signal — and ONLY for acquisition deals
  // (the extracted stage enum is acquisition-only; never write it onto a refi/
  // sale deal, whose stages are different).
  if (trackOf(target) === "acquisition" && extracted.stage && extracted.stage !== "sourcing") patch.stage = extracted.stage;

  patch.notes = [target.notes, noteLine(email, extracted)].filter(Boolean).join("\n");
  patch.contacts = mergeArrays(target.contacts, extracted.contacts);
  patch.key_dates = mergeArrays(target.key_dates, extracted.key_dates);
  patch.documents = mergeArrays(target.documents, mergeDocs(extracted.documents, (email.uploadedDocs || []).filter((d) => !isImage(d))));
  const newPhotos = (email.uploadedDocs || []).filter(isImage).map((d) => ({ path: d.path, name: d.name }));
  if (!(target.photos || []).length) {
    const sp = await fetchBuildingPhoto(extracted.address, email.messageId);
    if (sp) newPhotos.push(sp);
  }
  patch.photos = mergeArrays(target.photos, newPhotos);
  const update = buildUpdate(email, extracted);
  if (update) patch.updates = mergeArrays(target.updates, [update]);
  if (!target.comps) {
    const comps = await buildComps(extracted);
    if (comps) patch.comps = comps;
  }
  if (extracted.links?.length) patch.links = mergeArrays(target.links, extracted.links);
  // Always refresh the "latest email" summary shown live on the deal.
  patch.last_email_summary = extracted.summary;
  patch.last_email_at = email.date;
  patch.last_email_from = email.from;

  if (DRY_RUN) {
    console.log(`  DRY: would UPDATE "${target.nickname}" (${target.id.slice(0, 8)})`);
    return;
  }
  const { error } = await supabase.from("deals").update(patch).eq("id", target.id);
  if (error) throw error;
  console.log(`  UPDATE "${target.nickname}" (${target.id.slice(0, 8)})`);
  // Apply the merged values onto the in-memory snapshot so a later email in this
  // same batch that also matches this deal merges from the up-to-date state
  // (not the stale pre-update copy) and doesn't clobber what we just wrote.
  Object.assign(target, patch);
  await sendReply(email, { action: "Updated", nickname: target.nickname, address: patch.address ?? target.address, asking_price: patch.asking_price, summary: extracted.summary });
}

// Record a vendor invoice / account statement into the invoices table.
async function applyInvoice(email, extracted) {
  const inv = extracted.invoice;
  // Try to link the invoice to a deal by the property it references.
  let deal_id = null;
  let deal_nickname = null;
  if (inv.property) {
    const { data: deals } = await supabase.from("deals").select("id,nickname,address");
    const n = norm(inv.property);
    const match = (deals || []).find((d) => {
      const da = norm(d.address);
      const dn = norm(d.nickname);
      if (!n) return false;
      if (da === n || dn === n) return true;
      return !!da && (da.includes(n) || n.includes(da)) && Math.min(da.length, n.length) >= 8;
    });
    if (match) { deal_id = match.id; deal_nickname = match.nickname; }
  }
  const row = {
    type: inv.type === "statement" ? "statement" : "invoice",
    status: "owed",
    vendor_name: inv.vendor_name,
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date,
    amount: inv.amount,
    deal_id,
    deal_nickname,
    email_subject: email.subject,
    email_date: email.date,
    email_sender: email.from,
    source_email_id: email.messageId,
    owner_email: email.fromAddress || email.from,
  };
  if (DRY_RUN) {
    console.log(`  DRY: would record ${row.type} from ${row.vendor_name || "?"}`);
    return;
  }
  const { error } = await supabase.from("invoices").insert(row);
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) { console.log("  invoice already recorded — skipping"); return; }
    throw error;
  }
  console.log(`  🧾 ${row.type.toUpperCase()}: ${[row.vendor_name, row.invoice_number, row.amount ? "$" + Number(row.amount).toLocaleString() : ""].filter(Boolean).join(" · ")}`);
  await alertOnTrend(row);
}

// Email an alert (default to the deals inbox, or ALERT_EMAIL) for invoice trends.
async function sendAlert(subject, body) {
  const to = process.env.ALERT_EMAIL || process.env.GMAIL_USER;
  if (DRY_RUN || !to) return;
  try {
    _mailer ??= nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true, family: 4,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await _mailer.sendMail({ from: process.env.GMAIL_USER, to, subject: `[DealFlow alert] ${subject}`, text: body });
    console.log("  🔔 alert sent: " + subject);
  } catch (e) {
    console.error("  alert failed: " + e.message);
  }
}

// On a new invoice, if the vendor bills recurringly and this amount spikes well
// above their average, send a heads-up.
async function alertOnTrend(row) {
  if (!row.vendor_name || !row.amount) return;
  const { data: prior } = await supabase
    .from("invoices")
    .select("amount")
    .eq("vendor_name", row.vendor_name)
    .neq("source_email_id", row.source_email_id || "");
  const amts = (prior || []).map((p) => p.amount).filter((a) => a != null);
  if (amts.length < 2) return; // not enough history to call it recurring
  const avg = amts.reduce((a, b) => a + b, 0) / amts.length;
  if (row.amount > avg * 1.4) {
    const pct = Math.round((row.amount / avg - 1) * 100);
    await sendAlert(
      `${row.vendor_name} invoice up ${pct}%`,
      `${row.vendor_name} just billed $${Number(row.amount).toLocaleString()}, ${pct}% above their average of $${Math.round(avg).toLocaleString()} across ${amts.length} prior invoices.` +
        (row.deal_nickname ? `\nProperty: ${row.deal_nickname}` : "") +
        `\n\nSee → https://dealflow-self-eight.vercel.app/invoices`
    );
  }
}

// ── main ────────────────────────────────────────────────────────────────────
// Connect, run fn(client), always disconnect. Kept short-lived on purpose so the
// IMAP socket is never held open across the slow per-email Claude calls (Gmail
// times the connection out and crashes the run if you do).
async function withImap(fn, creds) {
  const user = creds?.user || process.env.GMAIL_USER;
  const pass = creds?.pass || process.env.GMAIL_APP_PASSWORD;
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    socketTimeout: 120000,
    tls: { family: 4 }, // force IPv4 (Railway IPv6 is unreachable)
  });
  // ImapFlow emits 'error' outside the promise chain; without a listener an async
  // socket error would crash the process. Callers handle failures via try/catch.
  client.on("error", () => {});
  await client.connect();
  const lock = await client.getMailboxLock(process.env.GMAIL_MAILBOX || "INBOX");
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

// Optional dedicated invoice inbox: if INVOICE_GMAIL_USER is set, read that mailbox
// and record invoices/statements from it (deals in this inbox are ignored).
async function processInvoiceInbox() {
  const user = process.env.INVOICE_GMAIL_USER;
  const pass = process.env.INVOICE_GMAIL_APP_PASSWORD;
  if (!user || !pass) return;
  const creds = { user, pass };
  const { data: invRows } = await supabase.from("invoices").select("source_email_id");
  const seenIds = new Set((invRows || []).filter((r) => r.source_email_id).map((r) => r.source_email_id));
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
  const raw = await withImap(async (client) => {
    const uids = await client.search({ seen: false, since }, { uid: true });
    if (!uids || uids.length === 0) return [];
    const out = [];
    for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) out.push({ uid: msg.uid, source: msg.source });
    return out;
  }, creds);
  if (!raw.length) { console.log(`\nInvoice inbox (${user}): no new messages.`); return; }
  console.log(`\nInvoice inbox (${user}): ${raw.length} message(s).`);
  const toSeen = [];
  for (const item of raw) {
    try {
      const parsed = await simpleParser(item.source);
      const messageId = stableId(parsed);
      console.log(`• ${parsed.subject || "(no subject)"}`);
      if (seenIds.has(messageId)) { console.log("  already recorded — skipping"); toSeen.push(item.uid); continue; }
      const email = {
        subject: parsed.subject || "(no subject)",
        from: parsed.from?.text || "unknown",
        fromAddress: parsed.from?.value?.[0]?.address || null,
        date: (parsed.date || new Date()).toISOString(),
        text: parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "",
        attachments: (parsed.attachments || []).map((a) => a.filename).filter(Boolean),
        attachmentFiles: (parsed.attachments || []).filter((a) => a.content && a.filename).map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
        messageId,
      };
      const extracted = await extractDeal(email);
      if (extracted.invoice && extracted.invoice.is_invoice) {
        await applyInvoice(email, extracted);
      } else {
        console.log("  not an invoice — skipping");
      }
      seenIds.add(messageId);
      toSeen.push(item.uid);
    } catch (err) {
      console.error(`  ERROR — left unread for retry: ${err.message}`);
      if (isFatalApi(err.message) && !fatalAlerted) {
        fatalAlerted = true;
        process.exitCode = 1;
        await sendAlert("DealFlow bot is failing", `The agent hit a likely fatal error (check your Anthropic credit balance / API keys):\n\n${err.message}\n\nNew deals/invoices won't import until this is resolved.`);
      }
    }
  }
  if (!DRY_RUN && toSeen.length) {
    try {
      await withImap(async (client) => { await client.messageFlagsAdd({ uid: toSeen }, ["\\Seen"], { uid: true }); }, creds);
    } catch (err) {
      console.error(`Could not mark invoice messages read: ${err.message}`);
    }
  }
}

async function main() {
  // Pull the current pipeline + the set of already-ingested Message-IDs.
  const { data: deals, error: readErr } = await supabase
    .from("deals")
    .select("id, nickname, address, status, track, stage, notes, contacts, key_dates, documents, photos, updates, comps, links, source_email_id");
  if (readErr) {
    console.error("Could not read deals from Supabase:", readErr.message);
    process.exit(1);
  }
  const alreadyIngested = new Set(deals.filter((d) => d.source_email_id).map((d) => d.source_email_id));
  const { data: invRows } = await supabase.from("invoices").select("source_email_id");
  for (const r of invRows || []) if (r.source_email_id) alreadyIngested.add(r.source_email_id);

  // ── Phase 1: pull raw messages FAST, then disconnect. ──
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
  const raw = await withImap(async (client) => {
    const uids = await client.search({ seen: false, since }, { uid: true });
    if (!uids || uids.length === 0) return [];
    const out = [];
    for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
      out.push({ uid: msg.uid, source: msg.source });
    }
    return out;
  });

  if (raw.length === 0) {
    console.log("No new (unread) messages to process.");
    await processInvoiceInbox();
    return;
  }
  console.log(`Found ${raw.length} unread message(s) in the last ${LOOKBACK_DAYS} days.\n`);

  // ── Phase 2: process offline (no live IMAP). Mark an email read ONLY after it
  // has been successfully handled (inserted/updated/invoiced/not-a-deal/dup). An
  // email that fails — or a run that's interrupted before it's handled — stays
  // UNREAD and is retried next run. The deals' source_email_id makes that retry
  // a no-op (alreadyIngested → skip+mark), so it self-heals without losing mail. ──
  const toMarkSeen = [];
  let processed = 0;
  for (const item of raw) {
    // The ENTIRE body is in one try/catch — including parsing — so a single
    // malformed message can never throw out of the loop and abort the batch
    // (which would skip Phase 3 marking and re-pay for everything next run).
    let messageId;
    try {
      const parsed = await simpleParser(item.source);
      messageId = stableId(parsed);
      const subject = parsed.subject || "(no subject)";
      console.log(`• ${subject}`);

      if (alreadyIngested.has(messageId)) {
        console.log("  already ingested — skipping");
        toMarkSeen.push(item.uid);
        continue;
      }

      const email = {
        subject,
        from: parsed.from?.text || "unknown",
        fromAddress: parsed.from?.value?.[0]?.address || null,
        date: (parsed.date || new Date()).toISOString(),
        text: parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "",
        attachments: (parsed.attachments || []).map((a) => a.filename).filter(Boolean),
        attachmentFiles: (parsed.attachments || [])
          .filter((a) => a.content && a.filename)
          .map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
        messageId,
      };

      const extracted = await extractDeal(email);
      if (!extracted.is_real_estate_deal) {
        if (extracted.invoice && extracted.invoice.is_invoice) {
          await applyInvoice(email, extracted);
        } else {
          console.log("  not a deal — skipping");
        }
        toMarkSeen.push(item.uid);
        continue;
      }

      // Upload attachments to private storage (skipped on dry runs).
      email.uploadedDocs = DRY_RUN
        ? (email.attachments || []).map((name) => ({ name, type: "attachment", path: null, note: "dry run — not uploaded" }))
        : await uploadAttachments(email);

      const track = ["acquisition", "refi", "disposition"].includes(extracted.track) ? extracted.track : "acquisition";
      const decision = matchDeal(extracted, deals, track);
      if (decision.kind === "update") {
        await applyUpdate(email, extracted, decision.target);
      } else {
        const inserted = await applyInsert(email, extracted, decision.flag, track, deals);
        if (track !== "acquisition") console.log(`  → routed to ${track} pipeline`);
        // Keep the in-memory snapshot current so a later email in THIS batch about
        // the same property updates it instead of inserting a duplicate.
        if (inserted) deals.push(inserted);
      }
      processed++;
      alreadyIngested.add(messageId);
      toMarkSeen.push(item.uid);
    } catch (err) {
      // The deals.source_email_id unique violation means this exact email was
      // already recorded — done, not failing — so mark it read. Scope narrowly to
      // THAT constraint so an unrelated unique error never marks unwritten mail read.
      const dupEmail = (err.code === "23505" || /duplicate key|unique constraint/i.test(err.message || "")) &&
        /source_email_id/i.test((err.message || "") + " " + (err.details || ""));
      if (dupEmail) {
        console.log("  already recorded — marking read (no retry)");
        if (messageId) alreadyIngested.add(messageId);
        toMarkSeen.push(item.uid);
        continue;
      }
      // Real failure — leave it UNREAD so it retries next run.
      console.error(`  ERROR — left unread for retry: ${err.message}`);
      if (isFatalApi(err.message) && !fatalAlerted) {
        fatalAlerted = true;
        process.exitCode = 1;
        await sendAlert("DealFlow bot is failing", `The agent hit a likely fatal error (check your Anthropic credit balance / API keys):\n\n${err.message}\n\nNew deals/invoices won't import until this is resolved.`);
      }
    }
  }

  // ── Phase 3: reconnect and mark the SUCCESSFULLY-handled emails read. Retry a
  // few times — if it ultimately fails, the deal still exists, so next run's
  // alreadyIngested check re-marks it (self-healing, never loses mail). ──
  if (!DRY_RUN && toMarkSeen.length) {
    let marked = false;
    for (let attempt = 1; attempt <= 3 && !marked; attempt++) {
      try {
        await withImap(async (client) => {
          await client.messageFlagsAdd({ uid: toMarkSeen }, ["\\Seen"], { uid: true });
        });
        marked = true;
      } catch (err) {
        console.error(`Mark-read attempt ${attempt}/3 failed: ${err.message}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!marked) console.error("Could not mark messages read; they'll be re-marked next run (deals are safe).");
  }

  console.log(`\nDone. ${processed} deal(s) written${DRY_RUN ? " (dry run — nothing saved)" : ""}.`);

  // Then process the dedicated invoice inbox, if configured.
  await processInvoiceInbox();
}

// Heartbeat: stamp "the agent completed a check just now" into Supabase. An
// independent watchdog (check.mjs, run by GitHub Actions) alerts if this goes
// stale — so a dead Railway worker can't fail silently.
async function writeHeartbeat() {
  if (DRY_RUN) return;
  try {
    // Write to the storage bucket (which already exists) — NO database table or
    // SQL setup required. We CHECK the returned error (the old version ignored it
    // and falsely logged success against a table that didn't exist).
    const body = Buffer.from(JSON.stringify({ at: new Date().toISOString() }));
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload("_status/heartbeat.json", body, { upsert: true, contentType: "application/json" });
    if (error) { console.error("  heartbeat write FAILED: " + error.message); return; }
    console.log("  ♥ heartbeat written");
  } catch (e) {
    console.error("  heartbeat write FAILED: " + e.message);
  }
}

main()
  .then(writeHeartbeat)
  .catch(async (err) => {
    console.error("Fatal:", err);
    try { await sendAlert("DealFlow run crashed", `${err?.message || err}`); } catch {}
    // Still stamp the heartbeat: the process DID run a cycle, so the watchdog
    // shouldn't also cry "agent is DOWN" — the crash alert above is the signal.
    try { await writeHeartbeat(); } catch {}
    process.exit(1);
  });
