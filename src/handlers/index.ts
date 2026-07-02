import { childLogger } from "../core/logger";
import type { Handler } from "../core/handler";
import { compintelSnapshot, compintelGap, compintelDigest } from "../loops/compintel";
import { leadgenEnrich, leadgenVerify, leadgenDraft } from "../loops/leadgen";

const log = childLogger("handler");

// Handler kaydı. Faz 2'de leadgen:* handler'ları (source/verify/enrich/draft) eklenir.
export const handlers: Record<string, Handler> = {
  // Faz 0 smoke
  "test:echo": async (job) => {
    log.info({ jobId: job.id, payload: job.payload }, "test:echo işlendi");
    return { costUsd: 0 };
  },

  // Faz 1a — competitor / pazar istihbaratı
  "compintel:snapshot": compintelSnapshot,
  "compintel:gap": compintelGap,
  "compintel:digest": compintelDigest,

  // Faz 1b — lead-gen DRAFT pipeline (gönderim YOK; hepsi draft_for_review)
  "leadgen:enrich": leadgenEnrich,
  "leadgen:verify": leadgenVerify,
  "leadgen:draft": leadgenDraft,
};
