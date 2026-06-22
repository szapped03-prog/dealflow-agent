// Always-on runner: runs the ingest, waits for it to finish, then waits
// LOOP_SECONDS and runs again — forever. For hosting on Railway/Render so the
// agent genuinely checks every few minutes (GitHub's scheduler throttles to hours).
import { spawn } from "node:child_process";

const SECS = Number(process.env.LOOP_SECONDS || 60); // default every 60 seconds

function once() {
  const started = Date.now();
  const p = spawn("node", ["ingest.mjs"], { stdio: "inherit" });
  const scheduleNext = (label) => {
    // Fixed-rate: aim for SECS from the START of this run, not the end. If the
    // run took longer than SECS, fire the next one immediately (wait = 0).
    const elapsed = Date.now() - started;
    const wait = Math.max(0, SECS * 1000 - elapsed);
    console.log(`[loop] ${label} (${Math.round(elapsed / 1000)}s) — next in ${Math.round(wait / 1000)}s\n`);
    setTimeout(once, wait);
  };
  p.on("exit", (code) => scheduleNext(`run finished (exit ${code})`));
  p.on("error", (e) => scheduleNext(`failed to start run: ${e.message}`));
}

console.log(`[loop] DealFlow agent — checking every ${SECS}s`);
once();
