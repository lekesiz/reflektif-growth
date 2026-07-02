import { isEnabled } from "./core/switches";
import { runWorkerTurn } from "./core/worker";
import { reapExpired, type Loop } from "./core/queue";
import { audit } from "./core/audit";
import { childLogger } from "./core/logger";
import { env } from "./config/env";

const log = childLogger("tick");

// launchd entrypoint: (1) crash kurtarma reaper, (2) GLOBAL kill-switch, (3) enqueue-due (Faz 1+),
// (4) worker turları. Makine uyanınca çalışır; staleness guard (Faz 1+ enqueue'da) birikmeyi patlatmaz.
export async function tick(): Promise<void> {
  const reaped = await reapExpired();
  if (reaped > 0) log.warn({ reaped }, "expired lease geri alındı");

  if (!(await isEnabled("GLOBAL"))) {
    log.warn("GLOBAL kill-switch kapalı; tick atlandı");
    return;
  }

  // Faz 1+: burada enqueue-due gelir (competitor snapshot, lead source, drip) — staleness guard'lı.
  // Faz 0: yalnız bekleyen işleri işle.
  const loops: Array<[Loop, string[]]> = [
    ["test", ["test:echo"]],
    ["compintel", []], // Faz 1 kinds
    ["leadgen", []], // Faz 1 kinds
  ];

  let processed = 0;
  for (let i = 0; i < env.TICK_WORKER_TURNS; i++) {
    let anyRan = false;
    for (const [loop, kinds] of loops) {
      if (kinds.length === 0) continue;
      const r = await runWorkerTurn(loop, kinds);
      if (r === "ran") {
        anyRan = true;
        processed++;
      }
    }
    if (!anyRan) break;
  }

  await audit({ action: "tick.done", detail: { reaped, processed } });
  log.info({ reaped, processed }, "tick tamamlandı");
}
