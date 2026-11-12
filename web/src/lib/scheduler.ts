import { systemTransaction } from "@/lib/db";
import { recordAutoFailure, runAuto } from "@/lib/standing-core";

// Background work that runs inside the server process, with no user behind it.
// Today: creating orders from standing orders. Each run is harmless to repeat, so a missed or doubled tick does no damage.

const DEFAULT_MINUTES = 15;
const g = globalThis as unknown as { __aoScheduler?: ReturnType<typeof setInterval> };

async function tick() {
  try {
    await systemTransaction((q) => runAuto(q));
  } catch (e) {
    console.error("[scheduler] standing orders:", e);
    try {
      await systemTransaction((q) => recordAutoFailure(q, e instanceof Error ? e.message : String(e)));
    } catch {
      // The database itself is unavailable; the next tick tries again.
    }
  }
}

export function startScheduler() {
  if (g.__aoScheduler) return;
  const seconds = Number(process.env.AO_SCHEDULER_INTERVAL_SECONDS) || DEFAULT_MINUTES * 60;
  g.__aoScheduler = setInterval(tick, Math.max(5, seconds) * 1000);
  g.__aoScheduler.unref?.();
}
