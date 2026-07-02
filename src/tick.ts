import { isEnabled } from "./core/switches";
import { runWorkerTurn } from "./core/worker";
import { enqueue, reapExpired, type Loop } from "./core/queue";
import { query } from "./db/pool";
import { audit } from "./core/audit";
import { childLogger } from "./core/logger";
import { env } from "./config/env";

const log = childLogger("tick");

function isoDay(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoWeekKey(): string {
  const d = new Date();
  const week = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / (7 * 86_400_000));
  return `${d.getUTCFullYear()}-W${week}`;
}

// Vadesi gelen işleri enqueue et (dedupe_key ile idempotent → uyanışta tekrar patlamaz).
async function enqueueDue(): Promise<void> {
  if (await isEnabled("compintel")) {
    const comps = (await query<{ id: number }>(`select id from competitors where active=true`)).rows;
    const today = isoDay();
    for (const c of comps) {
      await enqueue({ loop: "compintel", kind: "compintel:snapshot", payload: { competitorId: c.id }, dedupeKey: `snapshot:${c.id}:${today}`, priority: 50 });
    }
    // Haftalık digest (bir hafta bir kez)
    await enqueue({ loop: "compintel", kind: "compintel:digest", payload: {}, dedupeKey: `digest:${isoWeekKey()}`, priority: 200 });
  }
  // Faz 2: leadgen source/drip enqueue-due buraya (staleness-guard'lı)
}

// launchd entrypoint.
export async function tick(): Promise<void> {
  const reaped = await reapExpired();
  if (reaped > 0) log.warn({ reaped }, "expired lease geri alındı");

  if (!(await isEnabled("GLOBAL"))) {
    log.warn("GLOBAL kill-switch kapalı; tick atlandı");
    return;
  }

  await enqueueDue();

  const loops: Array<[Loop, string[]]> = [
    ["test", ["test:echo"]],
    ["compintel", ["compintel:snapshot", "compintel:gap", "compintel:digest"]],
    ["leadgen", []], // Faz 2
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
