// extract.mjs — turn one email into a structured DealFlow record using Claude.
// Uses a forced tool call so the model must return JSON matching the deals
// schema (no fragile prompt-and-pray parsing). Forced tool use is supported on
// every Anthropic SDK version, unlike the newer output_config structured outputs.

import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";

// Lazy singleton — constructed on first use, AFTER ingest.mjs has loaded .env.
// (ES module imports run before the importer's body, so constructing at import
// time would miss env vars the caller sets at startup.)
let _client;
const getClient = () => (_client ??= new Anthropic());

// Trim a PDF to its first N pages to keep token cost low. Returns the original
// bytes if anything goes wrong (size cap downstream still guards).
async function firstPages(buf, n) {
  try {
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    if (src.getPageCount() <= n) return buf;
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, Array.from({ length: n }, (_, i) => i));
    pages.forEach((p) => out.addPage(p));
    return Buffer.from(await out.save());
  } catch {
    return buf;
  }
}

// Mirrors the columns in schema.sql + schema_email_agent.sql.
const DEAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_real_estate_deal: {
      type: "boolean",
      description:
        "true only if this email is about a specific real-estate acquisition/investment opportunity. Newsletters, marketing blasts, and personal mail are false.",
    },
    confidence: {
      type: "number",
      description: "0-1, how confident you are this is a real, actionable deal.",
    },
    nickname: {
      type: "string",
      description:
        "Short human label for the deal, e.g. 'Vernon Blvd MF' or 'FiDi Office Conv'. Derive from address + asset type if not stated.",
    },
    address: { type: ["string", "null"], description: "Street address of the property." },
    asset_type: {
      type: ["string", "null"],
      enum: ["multifamily", "office", "retail", "mixed-use", "industrial", "land", null],
    },
    submarket: { type: ["string", "null"], description: "Neighborhood/submarket, e.g. 'LIC', 'Bushwick'." },
    units: { type: ["integer", "null"], description: "Number of residential/commercial units, if stated." },
    asking_price: { type: ["number", "null"], description: "Asking price in whole US dollars (e.g. 18500000), null if unknown." },
    stage: {
      type: ["string", "null"],
      enum: ["sourcing", "loi", "under_contract", "due_diligence", "closed", "dead", null],
      description: "Pipeline stage implied by the email. Default to 'sourcing' for a fresh opportunity.",
    },
    broker: { type: ["string", "null"], description: "Primary broker's name." },
    firm: { type: ["string", "null"], description: "Brokerage / firm name." },
    next_step: { type: ["string", "null"], description: "The concrete next action implied by the email." },
    contacts: {
      type: "array",
      description: "Everyone involved: brokers, sellers, founders, investors, advisors, attorneys.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: ["string", "null"] },
          role: { type: ["string", "null"], description: "e.g. broker, seller, buyer, attorney, lender." },
          email: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
          firm: { type: ["string", "null"] },
        },
        required: ["name", "role", "email", "phone", "firm"],
      },
    },
    key_dates: {
      type: "array",
      description: "Deadlines and milestones: call for offers, LOI due, closing, inspection, etc.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string", description: "What the date is for." },
          date: { type: ["string", "null"], description: "ISO date YYYY-MM-DD if determinable, else null." },
          note: { type: ["string", "null"] },
        },
        required: ["label", "date", "note"],
      },
    },
    documents: {
      type: "array",
      description: "Documents referenced or attached: OM, deck, rent roll, T-12, financials, term sheet.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          type: { type: ["string", "null"], description: "e.g. OM, rent_roll, T12, deck, term_sheet." },
          note: { type: ["string", "null"] },
        },
        required: ["name", "type", "note"],
      },
    },
    summary: {
      type: "string",
      description: "One or two sentence plain-English summary of the opportunity, for the deal's notes.",
    },
    status_update: {
      type: "object",
      additionalProperties: false,
      description: "Project/operational status the email reports about an ongoing building (construction, leasing, tenants). Only for progress updates — NOT for a brand-new opportunity with no operational news.",
      properties: {
        has_update: { type: "boolean", description: "true only if this email reports real progress/news on the building's status (construction, leasing, tenants, financing, delays). false for a plain new-deal intro." },
        headline: { type: ["string", "null"], description: "One-line summary of what's new in this email." },
        progress: { type: ["string", "null"], description: "Progress made: construction milestones, deal/financing steps, leasing momentum." },
        delays: { type: ["string", "null"], description: "Any delays, blockers, issues, or risks raised." },
        tenants: { type: ["string", "null"], description: "Tenant/occupancy/leasing news: new leases, move-outs, occupancy %, rent collection, tenant issues." },
      },
      required: ["has_update", "headline", "progress", "delays", "tenants"],
    },
    comps: {
      type: "array",
      description: "Comparable sales or rentals found in the email body or attached documents (OMs and broker emails often include a sales-comps or rent-comps section). Pull each comp listed. Empty array if none are provided.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          address: { type: ["string", "null"], description: "Address or name of the comparable property." },
          price: { type: ["number", "null"], description: "Sale price or monthly rent in whole dollars." },
          metric: { type: ["string", "null"], description: "Key per-unit metric if given, e.g. '$425/SF', '$310K/unit', '4.6% cap'." },
          date: { type: ["string", "null"], description: "Sale/lease date if given (ISO where possible)." },
          kind: { type: ["string", "null"], enum: ["sale", "rent", null], description: "sale comp or rent comp." },
          note: { type: ["string", "null"], description: "Any other detail: units, SF, beds, distance, notes." },
          url: { type: ["string", "null"], description: "Source URL for this comp if one is given." },
        },
        required: ["address", "price", "metric", "date", "kind", "note", "url"],
      },
    },
    invoice: {
      type: "object",
      additionalProperties: false,
      description: "If the email is a VENDOR INVOICE or ACCOUNT STATEMENT (a bill to pay, not a real-estate deal), capture its details. Read attached invoice/statement PDFs.",
      properties: {
        is_invoice: { type: "boolean", description: "true if this email is a vendor invoice or account statement to track/pay." },
        type: { type: ["string", "null"], enum: ["invoice", "statement", null], description: "'invoice' for a single bill; 'statement' for an account/monthly statement." },
        vendor_name: { type: ["string", "null"], description: "The company/vendor billing." },
        invoice_number: { type: ["string", "null"] },
        invoice_date: { type: ["string", "null"], description: "Invoice/statement date, ISO YYYY-MM-DD." },
        amount: { type: ["number", "null"], description: "Total amount due in whole dollars." },
        property: { type: ["string", "null"], description: "The property/building address this invoice is for, if it references one (e.g. the service address on a utility bill)." },
      },
      required: ["is_invoice", "type", "vendor_name", "invoice_number", "invoice_date", "amount", "property"],
    },
  },
  required: [
    "is_real_estate_deal",
    "confidence",
    "nickname",
    "address",
    "asset_type",
    "submarket",
    "units",
    "asking_price",
    "stage",
    "broker",
    "firm",
    "next_step",
    "contacts",
    "key_dates",
    "documents",
    "summary",
    "status_update",
    "comps",
    "invoice",
  ],
};

const SYSTEM = `You extract real-estate deal data from forwarded emails for an acquisitions pipeline.
Rules:
- Only mark is_real_estate_deal=true for a specific property opportunity. Mark false for newsletters, listing-service digests, marketing, and personal mail.
- Prices are whole dollars: "$18.5M" -> 18500000, "$6.2 million" -> 6200000.
- Never invent facts. If a field isn't supported by the email, use null (or [] for lists).
- Derive a sensible nickname even when not stated (address + asset type).
- Today's date is provided; resolve relative dates ("next Friday") to ISO where you can, else leave note text.
- PDF attachments (offering memos, financing memos, rent rolls, flyers) are included when present — READ them and use them as the PRIMARY source for price, units, asset type, address, submarket, broker, and financials. The email body is often just a short cover note.
- status_update: set has_update=true only when the email reports ACTUAL progress on a building you'd track over time — construction milestones, financing/closing steps, leasing/occupancy changes, tenant issues, or delays. Capture progress / delays / tenants separately. For a first-time opportunity intro with no operational news, set has_update=false and leave the sub-fields null.
- comps: if the email or any attached document includes comparable sales or rentals (a "comps", "comparables", or "rent comps" section is common in OMs), extract each one into the comps array. Do not invent comps — only include comps actually present in the materials.
- invoice: a forwarded email may instead be a VENDOR INVOICE or ACCOUNT STATEMENT (a bill — utilities, legal, contractor, services). If so, set is_real_estate_deal=false AND invoice.is_invoice=true, and extract vendor, invoice number, date, amount, and whether it's an 'invoice' or 'statement'. Read the attached invoice PDF for these. A property opportunity is NOT an invoice.`;

/**
 * @param {{subject:string, from:string, date:string, text:string, attachments:string[]}} email
 * @returns {Promise<object>} validated deal object matching DEAL_SCHEMA
 */
export async function extractDeal(email) {
  const today = new Date().toISOString().slice(0, 10);
  const body = [
    `Today: ${today}`,
    `From: ${email.from}`,
    `Date: ${email.date}`,
    `Subject: ${email.subject}`,
    email.attachments?.length ? `Attachments: ${email.attachments.join(", ")}` : "Attachments: none",
    "",
    "--- Email body ---",
    (email.text || "").slice(0, 24000),
  ].join("\n");

  // Attach PDFs (first 15 pages each) so the model reads the OM/memo. Trimmed to
  // keep cost low; total inline size capped as a backstop.
  const MAX_PAGES = 15;
  const MAX_PDF_BYTES = 18 * 1024 * 1024;
  let used = 0;
  const docBlocks = [];
  for (const a of email.attachmentFiles || []) {
    const isPdf = /application\/pdf/i.test(a.contentType || "") || /\.pdf$/i.test(a.filename || "");
    if (!isPdf || !a.content) continue;
    const trimmed = await firstPages(a.content, MAX_PAGES);
    if (used + trimmed.length > MAX_PDF_BYTES) continue;
    used += trimmed.length;
    docBlocks.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: trimmed.toString("base64") },
      title: a.filename,
    });
  }

  // Use Sonnet when reading PDFs (cheaper than Opus on token-heavy docs, sharper
  // than Haiku); Opus for text-only.
  const call = (withDocs) =>
    getClient().messages.create({
      model: withDocs && docBlocks.length ? "claude-sonnet-4-6" : "claude-opus-4-8",
      max_tokens: 4000,
      system: SYSTEM,
      tools: [
        {
          name: "record_deal",
          description: "Record the extracted real-estate deal from the email and any attached documents.",
          input_schema: DEAL_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: "record_deal" },
      messages: [{ role: "user", content: withDocs && docBlocks.length ? [...docBlocks, { type: "text", text: body }] : body }],
    });

  let resp;
  try {
    resp = await call(docBlocks.length > 0);
  } catch (e) {
    if (!docBlocks.length) throw e;
    console.error(`  PDF read failed (${e.message}); retrying text-only`);
    resp = await call(false);
  }

  if (resp.stop_reason === "refusal") {
    throw new Error("Model refused to process this email.");
  }
  const toolUse = resp.content.find((b) => b.type === "tool_use" && b.name === "record_deal");
  if (!toolUse) throw new Error("Model did not return the record_deal tool call.");
  return toolUse.input; // already a parsed object matching DEAL_SCHEMA
}

const COMP_ITEM = {
  type: "object",
  additionalProperties: false,
  properties: {
    address: { type: ["string", "null"] },
    price: { type: ["number", "null"], description: "Sale price (or rent), whole dollars." },
    metric: { type: ["string", "null"], description: "$/unit, $/SF, or cap rate if available." },
    date: { type: ["string", "null"], description: "Sale/lease date." },
    kind: { type: ["string", "null"], enum: ["sale", "rent", null] },
    note: { type: ["string", "null"], description: "Source name + any detail (units, SF)." },
    url: { type: ["string", "null"], description: "The source URL this comp came from." },
  },
  required: ["address", "price", "metric", "date", "kind", "note", "url"],
};

// Actively SEARCH THE WEB for recent comparable sales near a property and return
// them structured. Two steps: research with the web_search tool, then structure.
export async function findComps(deal) {
  if (!deal.address && !deal.submarket) return [];
  const client = getClient();
  const target = [deal.nickname, deal.address, deal.submarket, deal.asset_type,
    deal.units ? `${deal.units} units` : null,
    deal.asking_price ? `asking $${Number(deal.asking_price).toLocaleString()}` : null]
    .filter(Boolean).join(" · ");

  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
  const messages = [{
    role: "user",
    content:
      `Find 4-6 RECENT (ideally last ~24 months) comparable SALES for the property below. ` +
      `Search the web — brokerage sites, The Real Deal, PincusCo, Crexi, CoStar news, public records. ` +
      `For each comp give: address, sale price, $/unit or $/SF if available, sale date, and a one-line source. ` +
      `Only real, sourced transactions near this property and similar in type/size. If you can't find solid comps, say so.\n\nProperty: ${target}`,
  }];

  // Collect the actual source URLs the web_search tool returned, across all turns.
  const sources = [];
  const collect = (content) => {
    for (const b of content || []) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) {
          if (r && r.type === "web_search_result" && r.url) sources.push({ title: r.title || "", url: r.url });
        }
      }
    }
  };

  let resp = await client.messages.create({ model: "claude-opus-4-8", max_tokens: 4000, tools, messages });
  collect(resp.content);
  let guard = 0;
  while (resp.stop_reason === "pause_turn" && guard++ < 6) {
    messages.push({ role: "assistant", content: resp.content });
    resp = await client.messages.create({ model: "claude-opus-4-8", max_tokens: 4000, tools, messages });
    collect(resp.content);
  }
  const findings = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!findings) return [];

  const seen = new Set();
  const srcList = sources.filter((s) => s.url && !seen.has(s.url) && seen.add(s.url));
  const sourcesText = srcList.length
    ? "\n\nSOURCE URLS (set each comp's url to the one that best matches it by title/topic):\n" + srcList.map((s) => `- ${s.title} — ${s.url}`).join("\n")
    : "";

  const s = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    tools: [{ name: "record_comps", description: "Record the comparable sales found.", input_schema: { type: "object", additionalProperties: false, properties: { comps: { type: "array", items: COMP_ITEM } }, required: ["comps"] } }],
    tool_choice: { type: "tool", name: "record_comps" },
    messages: [{ role: "user", content: `Extract the comparable sales below into structured data. Put the source name + date in note (e.g. "The Real Deal, Mar 2025"), and set url to the matching source URL from the list. Omit anything that isn't a real sourced comp.\n\nFINDINGS:\n${findings}${sourcesText}` }],
  });
  const tu = s.content.find((b) => b.type === "tool_use" && b.name === "record_comps");
  return tu ? (tu.input.comps || []) : [];
}
