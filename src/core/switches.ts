import { query } from "../db/pool";

// Redeploy'suz kill-switch. GLOBAL kapalıysa hiçbir loop çalışmaz.
export async function isEnabled(loop: string): Promise<boolean> {
  const g = await query<{ enabled: boolean }>(
    `select enabled from agent_switches where loop='GLOBAL'`,
  );
  if (!g.rows[0]?.enabled) return false;
  if (loop === "GLOBAL") return true;
  const l = await query<{ enabled: boolean }>(
    `select enabled from agent_switches where loop=$1`,
    [loop],
  );
  return l.rows[0]?.enabled ?? false;
}

export async function pause(loop: string, reason: string, by = "cli"): Promise<void> {
  await query(
    `insert into agent_switches(loop, enabled, paused_reason, updated_by, updated_at)
     values ($1, false, $2, $3, now())
     on conflict (loop) do update set
       enabled=false, paused_reason=excluded.paused_reason, updated_by=excluded.updated_by, updated_at=now()`,
    [loop, reason, by],
  );
}

export async function resume(loop: string, by = "cli"): Promise<void> {
  await query(
    `insert into agent_switches(loop, enabled, updated_by, updated_at)
     values ($1, true, $2, now())
     on conflict (loop) do update set
       enabled=true, paused_reason=null, updated_by=excluded.updated_by, updated_at=now()`,
    [loop, by],
  );
}
