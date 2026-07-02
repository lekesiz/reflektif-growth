import { childLogger } from "../core/logger";
import type { AgentJob } from "../core/queue";

const log = childLogger("handler");

export interface HandlerResult {
  costUsd?: number;
}

export type Handler = (job: AgentJob) => Promise<HandlerResult>;

// Handler kaydı. Faz 1'de competitor-intel + lead-gen handler'ları buraya eklenir:
//   "compintel:snapshot", "compintel:diff", "leadgen:source", "leadgen:verify",
//   "leadgen:enrich", "leadgen:draft" ...  (her biri LLM-önerir / kod-karar-verir)
export const handlers: Record<string, Handler> = {
  // Faz 0 smoke handler
  "test:echo": async (job) => {
    log.info({ jobId: job.id, payload: job.payload }, "test:echo işlendi");
    return { costUsd: 0 };
  },
};
