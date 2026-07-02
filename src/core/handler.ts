import type { AgentJob } from "./queue";

export interface HandlerResult {
  costUsd?: number;
}

export type Handler = (job: AgentJob) => Promise<HandlerResult>;
