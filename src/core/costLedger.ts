import { query } from "../db/pool";
import { env } from "../config/env";

export interface CostEntry {
  loop: string;
  jobId?: number;
  model?: string;
  provider?: string;
  usd: number;
  inputTokens?: number;
  outputTokens?: number;
}

export async function recordCost(x: CostEntry): Promise<void> {
  await query(
    `insert into agent_cost_ledger(loop, job_id, model, provider, input_tokens, output_tokens, usd)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [x.loop, x.jobId ?? null, x.model ?? null, x.provider ?? null, x.inputTokens ?? null, x.outputTokens ?? null, x.usd],
  );
}

export async function spentTodayUsd(loop: string): Promise<number> {
  const r = await query<{ s: string }>(
    `select coalesce(sum(usd),0)::text as s from agent_cost_ledger where loop=$1 and at::date=current_date`,
    [loop],
  );
  return Number(r.rows[0]?.s ?? 0);
}

// Loop başına günlük hard-cap (AGENT_DAILY_CAP_USD). Otonom loop'un para yakmasına karşı.
export async function capExceeded(loop: string): Promise<boolean> {
  return (await spentTodayUsd(loop)) >= env.AGENT_DAILY_CAP_USD;
}
