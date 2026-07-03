import { z } from "zod";
import { env } from "../config/env";
import { childLogger } from "../core/logger";
import { runJsonWithRepair } from "./repair";

const log = childLogger("ollama");

// retry/repair çekirdeği (runJsonWithRepair + yardımcıları) artık src/llm/repair.ts'te (Ollama + Claude paylaşır).

// Ollama /api/chat — JSON-mode + thinking kapalı; <think> defensive strip; zod-validate.
// Halüsinasyon guard'ının teknik zemini: serbest metin değil, ŞEMALI çıktı.
// Dayanıklılık: OLLAMA_MAX_ATTEMPTS'e kadar retry + repair-reprompt (timeout/parse/zod hatalarında).
export async function ollamaJson<S extends z.ZodTypeAny>(opts: {
  model?: string;
  system: string;
  user: string;
  schema: S;
  temperature?: number;
}): Promise<z.infer<S>> {
  const model = opts.model ?? env.OLLAMA_BULK_MODEL;
  return runJsonWithRepair<S>({
    schema: opts.schema,
    maxAttempts: env.OLLAMA_MAX_ATTEMPTS,
    baseTemperature: opts.temperature ?? 0,
    // Her deneme KENDİ AbortController + timeout'unu alır (birinin timeout'u sonrakini etkilemez);
    // clearTimeout finally'de → controller/timer leak yok.
    generate: async ({ repairSuffix: suffix, temperature }) => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), env.OLLAMA_TIMEOUT_MS);
      try {
        const res = await fetch(`${env.OLLAMA_HOST}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            model,
            stream: false,
            think: false,
            format: "json",
            options: { temperature },
            messages: [
              { role: "system", content: opts.system + suffix },
              { role: "user", content: opts.user },
            ],
          }),
        });
        if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = (await res.json()) as { message?: { content?: string } };
        return data.message?.content ?? "";
      } finally {
        clearTimeout(to);
      }
    },
    // Gözlemlenebilirlik: yalnız deneme sayısı + hata tipi + model (PII / gövde içeriği ASLA loglanmaz).
    onRepairSuccess: (attempt) => log.info({ attempt, model }, "ollama repair başarılı (JSON şema düzeltildi)"),
    onAttemptError: (attempt, kind) =>
      log.debug({ attempt, maxAttempts: env.OLLAMA_MAX_ATTEMPTS, model, errKind: kind }, "ollama deneme başarısız"),
  });
}

export async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${env.OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}
