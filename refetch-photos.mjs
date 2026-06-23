// One-off: re-pull the Street View photo for every deal that has an address,
// using the improved geocode + camera-aim logic, replacing the old (wrong) one.
// Manual/uploaded photos are kept. DRY_RUN=1 to preview.
import { readFileSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { createClient } from "@supabase/supabase-js";
setDefaultResultOrder("ipv4first");

try {
  for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const KEY = process.env.GOOGLE_MAPS_KEY || "";
const BUCKET = "deal-documents";
const DRY = !!process.env.DRY_RUN;
const safePath = (s) => (s || "file").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);

async function geocode(address) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`,
      { headers: { "User-Agent": "DealFlow/1.0 (SMA Equities)", "Accept-Language": "en" } });
    const d = await r.json();
    if (Array.isArray(d) && d[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) };
  } catch {}
  return null;
}
function bearing(a, b) {
  const toR = (x) => (x * Math.PI) / 180;
  const φ1 = toR(a.lat), φ2 = toR(b.lat), Δλ = toR(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}
async function streetview(address, folderKey) {
  if (!KEY || !address) return null;
  const geo = await geocode(address);
  const loc = geo ? `${geo.lat},${geo.lng}` : address;
  const meta = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${encodeURIComponent(loc)}&source=outdoor&key=${KEY}`).then((r) => r.json());
  if (meta.status !== "OK") return { skip: true };
  let aim = "";
  if (geo && meta.location && Number.isFinite(meta.location.lat)) aim = `&heading=${bearing(meta.location, geo)}&pitch=10`;
  const img = await fetch(`https://maps.googleapis.com/maps/api/streetview?size=640x640&location=${encodeURIComponent(loc)}&fov=72${aim}&source=outdoor&key=${KEY}`);
  if (!img.ok) return { skip: true };
  const buf = Buffer.from(await img.arrayBuffer());
  const path = `${safePath(folderKey)}/streetview.jpg`;
  if (DRY) return { path, aimed: !!aim };
  const { error } = await sb.storage.from(BUCKET).upload(path, buf, { contentType: "image/jpeg", upsert: true });
  if (error) { console.error("  upload failed: " + error.message); return { skip: true }; }
  return { path, aimed: !!aim };
}

const { data: deals } = await sb.from("deals").select("id,nickname,address,photos,source_email_id");
let fixed = 0;
for (const d of deals || []) {
  if (!d.address) { console.log(`- ${d.nickname}: no address, skipped`); continue; }
  const folderKey = d.source_email_id || d.id;
  const res = await streetview(d.address, folderKey);
  if (!res || res.skip) { console.log(`- ${d.nickname}: no street imagery`); continue; }
  // Keep manual photos; replace only the Street View entry.
  const kept = (d.photos || []).filter((p) => p.name !== "Street View");
  const newPhotos = [...kept, { path: res.path, name: "Street View" }];
  if (!DRY) await sb.from("deals").update({ photos: newPhotos }).eq("id", d.id);
  console.log(`✓ ${d.nickname}: ${res.aimed ? "aimed photo" : "photo (no geocode)"}${DRY ? " (dry)" : ""}`);
  fixed++;
  await new Promise((r) => setTimeout(r, 1200)); // be polite to Nominatim
}
console.log(`\nDone. ${fixed} deal photo(s) ${DRY ? "would be" : ""} refreshed.`);
