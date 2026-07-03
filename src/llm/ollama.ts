import { z } from "zod";
import { env } from "../config/env";
import { childLogger } from "../core/logger";

const log = childLogger("ollama");

// --- retry/repair yardımcıları (saf; ağdan bağımsız → smoke'ta test edilebilir) --------------------

// ZodObject şemasının alan adları (repair reprompt'ta "TAM olarak şu alanları döndür" için).
// Nesne olmayan şemalarda (ör. z.array) boş döner → jenerik mesaja düşer.
function schemaFieldNames(schema: z.ZodTypeAny): string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  return shape && typeof shape === "object" ? Object.keys(shape) : [];
}

// zod hatasını KISA + PII'siz özetle (yalnız alan yolu + zod mesajı; asla alan değeri değil).
// zod-dışı hata (fetch/timeout/parse) için Error.message.
function errSummary(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .slice(0, 6)
      .map((i) => `'${i.path.join(".") || "(kök)"}': ${i.message}`)
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

// Log/observability için hata sınıfı (PII yok — yalnız tür).
function errKind(err: unknown): "zod" | "timeout" | "parse/fetch" {
  if (err instanceof z.ZodError) return "zod";
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError" || name === "TimeoutError" ? "timeout" : "parse/fetch";
}

// Ham model çıktısını temizle (<think> defensive strip) + JSON'a çevir.
// Bazı modeller JSON'u metne sarar → ilk {...} bloğunu yakala. Başarısızsa THROW (retry tetikler).
function cleanRaw(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
function parseJson(cleaned: string): unknown {
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`ollama JSON parse edilemedi: ${cleaned.slice(0, 200)}`);
    return JSON.parse(m[0]);
  }
}

// Repair sistem-eki (yalnız 2. denemeden itibaren): önceki hata + önceki ham çıktı → modele GERİ BESLE,
// YALNIZ JSON YAPISINI düzeltmesini iste. İçeriği değiştirmeyi/uydurmayı KASITLI olarak yasaklar
// (AGENTS.md "LLM önerir, KOD karar verir": nihai çıktı yine schema.parse'tan geçmek zorunda).
function repairSuffix(summary: string, fields: string[], prevRaw: string): string {
  const fieldList = fields.length ? `{${fields.join(", ")}}` : "istenen şema";
  let s =
    `\n\n[DÜZELTME] Önceki yanıtın şu JSON şema hatasını verdi: ${summary}. ` +
    `Aynı içeriği KORU; hiçbir bilgi uydurma, ekleme veya değiştirme. ` +
    `Yalnız YAPIYI düzelt: TAM olarak şu alanları içeren geçerli JSON döndür: ${fieldList}. ` +
    `Fazladan açıklama, markdown veya kod bloğu YOK.`;
  if (prevRaw) s += `\n\nÖnceki (hatalı) yanıtın:\n${prevRaw.slice(0, 800)}`;
  return s;
}

// Saf(ish) retry/repair sürücüsü — ağ `generate` callback'inde; parse + zod-validate + retry burada.
// Her deneme başarısızsa (fetch/timeout | JSON.parse | zod.parse) bir sonraki deneme repair-reprompt alır.
// maxAttempts kesin üst sınır (sonsuz döngü yok); hepsi tükenirse SON hatayı THROW eder (sessiz boş/uydurma değer YOK).
export async function runJsonWithRepair<S extends z.ZodTypeAny>(opts: {
  schema: S;
  maxAttempts: number;
  // repairSuffix: ilk denemede "" (repair yok); temperature: ilk deneme deterministik, repair'de küçük nudge.
  generate: (a: { attempt: number; isRepair: boolean; repairSuffix: string; temperature: number }) => Promise<string>;
  baseTemperature?: number;
  repairTemperature?: number;
  onRepairSuccess?: (attempt: number) => void;
  onAttemptError?: (attempt: number, kind: string) => void;
}): Promise<z.infer<S>> {
  const fields = schemaFieldNames(opts.schema);
  let lastRaw = "";
  let lastSummary = "";
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const isRepair = attempt > 1;
    // İlk deneme: deterministik (temperature 0 / çağıranın verdiği). Repair: küçük nudge (0.2) —
    // 0'da model aynı hatalı yapıyı tekrar üretmeye eğilimli; ufak çeşitlilik onu şema-uyumuna iter.
    const temperature = isRepair ? (opts.repairTemperature ?? 0.2) : (opts.baseTemperature ?? 0);
    const suffix = isRepair ? repairSuffix(lastSummary, fields, lastRaw) : "";
    try {
      const content = await opts.generate({ attempt, isRepair, repairSuffix: suffix, temperature });
      const cleaned = cleanRaw(content);
      lastRaw = cleaned; // olası bir sonraki repair'e geri beslenir (govde/PII log'a değil, yalnız prompt'a)
      const parsed = parseJson(cleaned);
      const out = opts.schema.parse(parsed) as z.infer<S>;
      if (isRepair) opts.onRepairSuccess?.(attempt);
      return out;
    } catch (e) {
      lastErr = e;
      lastSummary = errSummary(e);
      opts.onAttemptError?.(attempt, errKind(e));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

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
