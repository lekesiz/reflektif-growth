import { z } from "zod";
import { env } from "../config/env";
import { ollamaJson } from "./ollama";
import { claudeConfigured, claudeJson } from "./claude";
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

// Nihai yazar (dışarı çıkacak metin) — öncelik: Claude (Haiku 4.5) → Vertex-EU → lokal Ollama fallback.
// Her yol try/catch; hata olursa BİR SONRAKİNE düşer (Ollama daima çalışır → writer hiç kilitlenmez).
// recordCost her başarılı yolda DOĞRU provider+model+usd yazar (Claude'da GERÇEK token-maliyeti; diğerlerinde 0).
export async function writerJson<S extends z.ZodTypeAny>(opts: {
  loop: string;
  jobId?: number;
  system: string;
  user: string;
  schema: S;
}): Promise<z.infer<S>> {
  if (claudeConfigured()) {
    // onSpend, her ücretli çağrıdan sonra biriken usd'yi buraya yazar → başarı VE başarısızlıkta kaydedilir.
    let claudeUsd = 0;
    try {
      const { data } = await claudeJson({
        system: opts.system,
        user: opts.user,
        schema: opts.schema,
        onSpend: (usd) => {
          claudeUsd = usd;
        },
      });
      // GERÇEK maliyet → AGENT_DAILY_CAP_USD guardrail'i gerçek harcamaya dayanır (usd=0 cap'i baypas ederdi).
      await recordCost({ loop: opts.loop, jobId: opts.jobId, provider: "anthropic", model: env.ANTHROPIC_WRITER_MODEL, usd: claudeUsd });
      return data;
    } catch (e) {
      // Claude THROW etti ama ücretli çağrılar yapılmış olabilir (bozuk/truncate JSON'da bile HTTP 200 ücretlidir).
      // Gerçekten harcanan parayı YİNE DE kaydet → cap gerçek harcamayı görür (aksi halde guardrail baypas edilir).
      if (claudeUsd > 0) {
        try {
          await recordCost({ loop: opts.loop, jobId: opts.jobId, provider: "anthropic", model: env.ANTHROPIC_WRITER_MODEL, usd: claudeUsd });
        } catch (rc) {
          log.warn({ err: rc instanceof Error ? rc.message : String(rc) }, "claude hata-maliyeti kaydedilemedi");
        }
      }
      log.warn({ err: e instanceof Error ? e.message : String(e) }, "claude başarısız → vertex/ollama fallback");
    }
  }
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
