// setpass.mjs — create or set the password for a DealFlow user (admin only).
//
// The password is read from an env var so it's never typed as an argument or
// printed. Run it like this (your password stays on your machine):
//
//   EMAIL="sam@smaequities.com" PASSWORD="choose-a-strong-one" node setpass.mjs
//
// If the user already exists, its password is updated; otherwise a new,
// email-confirmed user is created. There is no public sign-up in the app.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// tiny .env loader (no dep)
try {
  for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* rely on real environment */ }

const email = (process.env.EMAIL || "").trim().toLowerCase();
const password = process.env.PASSWORD || "";

if (!email || !password) {
  console.error('Usage: EMAIL="you@firm.com" PASSWORD="strong-password" node setpass.mjs');
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Find an existing user with this email (scan pages; teams are small).
let existing = null;
for (let page = 1; page <= 20 && !existing; page++) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error("listUsers failed:", error.message); process.exit(1); }
  existing = (data.users || []).find((u) => (u.email || "").toLowerCase() === email) || null;
  if (!data.users || data.users.length < 200) break;
}

if (existing) {
  const { error } = await supabase.auth.admin.updateUserById(existing.id, { password });
  if (error) { console.error("Could not set password:", error.message); process.exit(1); }
  console.log(`✅ Password updated for existing user ${email}`);
} else {
  const { error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) { console.error("Could not create user:", error.message); process.exit(1); }
  console.log(`✅ Created user ${email} (email confirmed) — they can sign in now`);
}
