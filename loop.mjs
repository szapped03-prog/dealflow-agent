// Always-on runner: runs the ingest, waits for it to finish, then waits
// LOOP_SECONDS and runs again — forever. For hosting on Railway/Render so the
// agent genuinely checks every few minutes (GitHub's scheduler throttles to hours).
import { spawn } from "node:child_process";

const SECS = Number(process.env.LOOP_SECONDS || 300); // default every 5 minutes

function once() {
  const started = Date.now();
  const p = spawn("node", ["ingest.mjs"], { stdio: "inherit" });
  p.on("exit", (code) => {
    console.log(`[loop] run finished (exit ${code}, ${Math.round((Date.now() - started) / 1000)}s) — next in ${SECS}s\n`);
    setTimeout(once, SECS * 1000);
  });
  p.on("error", (e) => {
    console.error(`[loop] failed to start run: ${e.message} — retrying in ${SECS}s`);
    setTimeout(once, SECS * 1000);
  });
}

console.log(`[loop] DealFlow agent — checking every ${SECS}s`);
once();
