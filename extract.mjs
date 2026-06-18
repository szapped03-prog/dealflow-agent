// extract.mjs — turn one email into a structured DealFlow record using Claude.
// Uses a forced tool call so the model must return JSON matching the deals
// schema (no fragile prompt-and-pray parsing). Forced tool use is supported on
// every Anthropic SDK version, unlike the newer output_config structured outputs.

import Anthropic from "@anthropic-ai/sdk";

// Lazy singleton — constructed on first use, AFTER ingest.mjs has loaded .env.
// (ES module imports run before the importer's body, so constructing at import
// time would miss env vars the caller sets at startup.)
let _client;
const getClient = () => (_client ??= new Anthropic());

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
  ],
};

const SYSTEM = `You extract real-estate deal data from forwarded emails for an acquisitions pipeline.
Rules:
- Only mark is_real_estate_deal=true for a specific property opportunity. Mark false for newsletters, listing-service digests, marketing, and personal mail.
- Prices are whole dollars: "$18.5M" -> 18500000, "$6.2 million" -> 6200000.
- Never invent facts. If a field isn't supported by the email, use null (or [] for lists).
- Derive a sensible nickname even when not stated (address + asset type).
- Today's date is provided; resolve relative dates ("next Friday") to ISO where you can, else leave note text.`;

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

  const resp = await getClient().messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4000,
    system: SYSTEM,
    tools: [
      {
        name: "record_deal",
        description: "Record the extracted real-estate deal from the email.",
        input_schema: DEAL_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "record_deal" },
    messages: [{ role: "user", content: body }],
  });

  if (resp.stop_reason === "refusal") {
    throw new Error("Model refused to process this email.");
  }
  const toolUse = resp.content.find((b) => b.type === "tool_use" && b.name === "record_deal");
  if (!toolUse) throw new Error("Model did not return the record_deal tool call.");
  return toolUse.input; // already a parsed object matching DEAL_SCHEMA
}
