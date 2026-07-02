import { query } from "../db/pool";

export interface AuditRow {
  loop?: string;
  actor?: string;
  action: string;
  target?: string;
  riskTier?: "green" | "yellow" | "red";
  decision?: "auto" | "gated" | "human_approved" | "vetoed" | "blocked";
  detail?: unknown;
}

// Append-only denetim defteri (DB trigger UPDATE/DELETE'i reddeder)
export async function audit(r: AuditRow): Promise<void> {
  await query(
    `insert into agent_audit(loop, actor, action, target, risk_tier, decision, detail)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      r.loop ?? null,
      r.actor ?? "system",
      r.action,
      r.target ?? null,
      r.riskTier ?? null,
      r.decision ?? null,
      JSON.stringify(r.detail ?? {}),
    ],
  );
}
