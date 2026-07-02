import os from "node:os";
import { childLogger } from "./logger";
import { isEnabled } from "./switches";
import { capExceeded } from "./costLedger";
import { claim, markRunning, complete, fail, type Loop } from "./queue";
import { audit } from "./audit";
import { handlers } from "../handlers/index";
import { env } from "../config/env";

const log = childLogger("worker");
const WORKER_ID = `${os.hostname()}#${process.pid}`;

export type TurnResult = "ran" | "idle" | "paused" | "capped";

// Bir worker turu: kill-switch + cost-cap kontrolü → claim → handler → complete/fail.
export async function runWorkerTurn(loop: Loop, kinds: string[]): Promise<TurnResult> {
  if (!(await isEnabled(loop))) return "paused";
  if (await capExceeded(loop)) {
    await audit({ loop, action: "cost.cap.exceeded", decision: "blocked" });
    return "capped";
  }

  const job = await claim(loop, kinds, WORKER_ID, env.WORKER_LEASE_SECONDS);
  if (!job) return "idle";

  await markRunning(job.id);
  const handler = handlers[job.kind];
  if (!handler) {
    await fail(job.id, `no handler for kind '${job.kind}'`);
    await audit({ loop, action: "job.no_handler", target: String(job.id), decision: "blocked" });
    return "ran";
  }

  try {
    const res = await handler(job);
    await complete(job.id, res?.costUsd ?? 0);
    await audit({ loop, action: "job.done", target: String(job.id), decision: "auto", detail: { kind: job.kind } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await fail(job.id, msg);
    await audit({ loop, action: "job.failed", target: String(job.id), decision: "auto", detail: { kind: job.kind, error: msg } });
    log.error({ jobId: job.id, err: msg }, "job failed");
  }
  return "ran";
}
