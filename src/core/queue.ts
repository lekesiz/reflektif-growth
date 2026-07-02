import { query } from "../db/pool";

export type Loop = "compintel" | "leadgen" | "test";

export interface AgentJob {
  id: number;
  loop: Loop;
  kind: string;
  payload: Record<string, unknown>;
  priority: number;
  risk_tier: string;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: string;
}

export interface EnqueueInput {
  loop: Loop;
  kind: string;
  payload?: unknown;
  priority?: number;
  riskTier?: "green" | "yellow" | "red";
  dedupeKey?: string;
  runAfter?: Date;
  maxAttempts?: number;
}

// dedupeKey ile idempotent enqueue: aynı iş iki kez girmez (ON CONFLICT DO NOTHING).
export async function enqueue(x: EnqueueInput): Promise<number | null> {
  const r = await query<{ id: number }>(
    `insert into agent_jobs(loop, kind, payload, priority, risk_tier, dedupe_key, run_after, max_attempts)
     values ($1,$2,$3,$4,$5,$6,coalesce($7, now()),$8)
     on conflict (dedupe_key) do nothing
     returning id`,
    [
      x.loop,
      x.kind,
      JSON.stringify(x.payload ?? {}),
      x.priority ?? 100,
      x.riskTier ?? "green",
      x.dedupeKey ?? null,
      x.runAfter ?? null,
      x.maxAttempts ?? 3,
    ],
  );
  return r.rows[0]?.id ?? null;
}

// Tek iş claim (FOR UPDATE SKIP LOCKED RPC). Çok worker güvenli.
export async function claim(
  loop: Loop,
  kinds: string[],
  worker: string,
  leaseSeconds: number,
): Promise<AgentJob | null> {
  const r = await query<AgentJob>(`select * from claim_agent_job($1,$2,$3,$4)`, [
    loop,
    kinds,
    worker,
    leaseSeconds,
  ]);
  return r.rows[0] ?? null;
}

export async function markRunning(id: number): Promise<void> {
  await query(`update agent_jobs set status='running', updated_at=now() where id=$1`, [id]);
}

export async function complete(id: number, costUsd = 0): Promise<void> {
  await query(
    `update agent_jobs set status='done', cost_usd=cost_usd+$2, locked_by=null, locked_until=null, updated_at=now() where id=$1`,
    [id, costUsd],
  );
}

// Backoff (2^attempts*30s, max 1h) ya da max_attempts aşılınca 'dead'.
export async function fail(id: number, err: string): Promise<void> {
  await query(
    `update agent_jobs set
       status = case when attempts >= max_attempts then 'dead'::agent_job_status else 'pending'::agent_job_status end,
       run_after = now() + make_interval(secs => least(3600, (power(2, attempts) * 30)::int)),
       last_error = $2, locked_by=null, locked_until=null, updated_at=now()
     where id=$1`,
    [id, err.slice(0, 2000)],
  );
}

// Crash kurtarma: lease süresi geçmiş 'claimed'/'running' işleri 'pending'e geri al.
// 'running' de kapsanmalı: worker markRunning() sonrası handler çalışırken process SIGTERM alırsa
// (ör. tick script'i dıştan kesilirse) job süresiz 'running'de takılı kalır, yalnız 'claimed' yeterli değil.
export async function reapExpired(): Promise<number> {
  const r = await query(
    `update agent_jobs set status='pending', locked_by=null, locked_until=null, updated_at=now()
     where status in ('claimed','running') and locked_until < now()`,
  );
  return r.rowCount ?? 0;
}
