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
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import { extractDeal } from "./extract.mjs";

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

// Text alerts: send a text when a new deal lands, via the carrier email-to-SMS
// gateway (e.g. 3053191776@txt.att.net) using the same Gmail account over SMTP.
const SMS_TO = process.env.SMS_TO || "";
let _mailer;
async function textNewDeal(label, address, price) {
  if (!SMS_TO || DRY_RUN) return;
  try {
    _mailer ??= nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    const body =
      `New deal: ${label}` +
      (address ? ` — ${address}` : "") +
      (price ? ` — $${Number(price).toLocaleString()}` : "");
    await _mailer.sendMail({ from: process.env.GMAIL_USER, to: SMS_TO, subject: "DealFlow", text: body });
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

// ── helpers ──────────────────────────────────────────────────────────────────
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

// Decide how an extracted deal relates to what's already in the pipeline.
// Returns { kind: 'update'|'insert', target?, flag? }.
function matchDeal(extracted, deals) {
  const exAddr = norm(extracted.address);
  const exNick = norm(extracted.nickname);

  // Confident match: identical normalized address, or identical nickname.
  const strong = deals.find(
    (d) => (exAddr && norm(d.address) === exAddr) || (exNick && norm(d.nickname) === exNick)
  );
  if (strong) return { kind: "update", target: strong };

  // Loose match: share the street number + at least one other word. Ambiguous →
  // insert but flag for a human, rather than risk corrupting the wrong deal.
  if (exAddr) {
    const exTokens = new Set(exAddr.split(" "));
    const exNum = [...exTokens].find((t) => /^\d+$/.test(t));
    const loose = deals.filter((d) => {
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

// ── write paths ───────────────────────────────────────────────────────────────
async function applyInsert(email, extracted, flag) {
  const flagged = !!flag || extracted.confidence < CONFIDENCE_FLOOR;
  const noteParts = [];
  if (flag) noteParts.push(`[NEEDS REVIEW: ${flag}]`);
  if (extracted.confidence < CONFIDENCE_FLOOR)
    noteParts.push(`[LOW CONFIDENCE ${extracted.confidence.toFixed(2)}]`);
  noteParts.push(noteLine(email, extracted));

  const row = {
    status: "pipeline",
    nickname: extracted.nickname || email.subject?.slice(0, 60) || "Untitled deal",
    address: extracted.address,
    asset_type: extracted.asset_type,
    submarket: extracted.submarket,
    units: extracted.units,
    asking_price: extracted.asking_price,
    stage: extracted.stage || "sourcing",
    broker: extracted.broker,
    firm: extracted.firm,
    next_step: extracted.next_step,
    notes: noteParts.join("\n"),
    contacts: extracted.contacts || [],
    key_dates: extracted.key_dates || [],
    documents: mergeArrays(extracted.documents, email.uploadedDocs || []),
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
    return;
  }
  const { error } = await supabase.from("deals").insert(row);
  if (error) throw error;
  console.log(`  INSERT "${row.nickname}"${flagged ? " (flagged for review)" : ""}`);
  await textNewDeal(row.nickname, row.address, row.asking_price);
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
  // Stage only advances on an explicit signal — don't silently flip a deal back to sourcing.
  if (extracted.stage && extracted.stage !== "sourcing") patch.stage = extracted.stage;

  patch.notes = [target.notes, noteLine(email, extracted)].filter(Boolean).join("\n");
  patch.contacts = mergeArrays(target.contacts, extracted.contacts);
  patch.key_dates = mergeArrays(target.key_dates, extracted.key_dates);
  patch.documents = mergeArrays(target.documents, mergeArrays(extracted.documents, email.uploadedDocs || []));
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
}

// ── main ────────────────────────────────────────────────────────────────────
// Connect, run fn(client), always disconnect. Kept short-lived on purpose so the
// IMAP socket is never held open across the slow per-email Claude calls (Gmail
// times the connection out and crashes the run if you do).
async function withImap(fn) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
    socketTimeout: 120000,
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

async function main() {
  // Pull the current pipeline + the set of already-ingested Message-IDs.
  const { data: deals, error: readErr } = await supabase
    .from("deals")
    .select("id, nickname, address, stage, notes, contacts, key_dates, documents, source_email_id");
  if (readErr) {
    console.error("Could not read deals from Supabase:", readErr.message);
    process.exit(1);
  }
  const alreadyIngested = new Set(deals.filter((d) => d.source_email_id).map((d) => d.source_email_id));

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
    return;
  }
  console.log(`Found ${raw.length} unread message(s) in the last ${LOOKBACK_DAYS} days.\n`);

  // ── Phase 2: process offline (no live IMAP). Collect UIDs to mark read. ──
  const toMarkSeen = [];
  let processed = 0;
  for (const item of raw) {
    const parsed = await simpleParser(item.source);
    const messageId = parsed.messageId || `uid-${item.uid}@${process.env.GMAIL_USER}`;
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

    try {
      const extracted = await extractDeal(email);
      if (!extracted.is_real_estate_deal) {
        console.log("  not a deal — skipping");
        toMarkSeen.push(item.uid);
        continue;
      }

      // Upload attachments to private storage (skipped on dry runs).
      email.uploadedDocs = DRY_RUN
        ? (email.attachments || []).map((name) => ({ name, type: "attachment", path: null, note: "dry run — not uploaded" }))
        : await uploadAttachments(email);

      const decision = matchDeal(extracted, deals);
      if (decision.kind === "update") {
        await applyUpdate(email, extracted, decision.target);
      } else {
        await applyInsert(email, extracted, decision.flag);
      }
      processed++;
      alreadyIngested.add(messageId);
      toMarkSeen.push(item.uid);
    } catch (err) {
      console.error(`  ERROR — left unread for retry: ${err.message}`);
    }
  }

  // ── Phase 3: reconnect briefly and mark everything we handled as read. ──
  if (!DRY_RUN && toMarkSeen.length) {
    try {
      await withImap(async (client) => {
        await client.messageFlagsAdd({ uid: toMarkSeen }, ["\\Seen"], { uid: true });
      });
    } catch (err) {
      console.error(`Could not mark messages read (they'll be reconsidered next run): ${err.message}`);
    }
  }

  console.log(`\nDone. ${processed} deal(s) written${DRY_RUN ? " (dry run — nothing saved)" : ""}.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
