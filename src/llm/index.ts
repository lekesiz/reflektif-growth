import { z } from "zod";
import { env } from "../config/env";
import { ollamaJson } from "./ollama";
import { vertexConfigured, vertexJson } from "./vertex";
import { recordCost } from "../core/costLedger";
import { childLogger } from "../core/logger";

const log = childLogger("llm");

// Kütle işi (dedupe/skor/sınıflama/gap) — daima lokal Ollama (ücretsiz, veri makinede).
export async function bulkJson<S extends z.ZodTypeAny>(opts: {
  loop: string;
  jobId?: number;
  system: string;
  user: string;
  schema: S;
}): Promise<z.infer<S>> {
  const out = await ollamaJson({ ...opts, model: env.OLLAMA_BULK_MODEL });
  await recordCost({ loop: opts.loop, jobId: opts.jobId, provider: "ollama", model: env.OLLAMA_BULK_MODEL, usd: 0 });
  return out;
}

// Nihai yazar (dışarı çıkacak metin) — Vertex-EU varsa onu; yoksa güçlü lokal fallback.
export async function writerJson<S extends z.ZodTypeAny>(opts: {
  loop: string;
  jobId?: number;
  system: string;
  user: string;
  schema: S;
}): Promise<z.infer<S>> {
  if (vertexConfigured()) {
    try {
      const out = await vertexJson<z.infer<S>>({ system: opts.system, user: opts.user, schema: opts.schema });
      await recordCost({ loop: opts.loop, jobId: opts.jobId, provider: "vertex-eu", model: "gemini", usd: 0 /* TODO: token maliyeti */ });
      return out;
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, "vertex başarısız → lokal fallback");
    }
  }
  const out = await ollamaJson({ ...opts, model: env.OLLAMA_WRITER_MODEL });
  await recordCost({ loop: opts.loop, jobId: opts.jobId, provider: "ollama", model: env.OLLAMA_WRITER_MODEL, usd: 0 });
  return out;
}
