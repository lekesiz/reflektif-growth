import { z } from "zod";
import { env } from "../config/env";
import { childLogger } from "../core/logger";
import { runJsonWithRepair } from "./repair";

const log = childLogger("claude");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Anthropic'te Ollama'nın format:"json" modu YOK → JSON'u prompt talimatıyla zorlarız.
// (Ek güvenlik ağı: repair.ts parseJson ilk {...} bloğunu yakalar + repair-reprompt zod hatasında tekrar dener.)
const JSON_ONLY_INSTRUCTION =
  "\n\nÇIKTI KURALI: YALNIZ geçerli JSON döndür. Markdown, kod bloğu (```), açıklama veya ek metin YOK. " +
  "Yanıtın ilk karakteri '{' olmalı.";

// Anthropic'in 4.7+/5-ailesi sampling paramlarını (temperature/top_p/top_k) REDDEDER → gövdede
// varsa 400 (Sonnet 5'te varsayılan-dışı değer, diğerlerinde herhangi bir değer). Bu modeller için
// temperature'ı gövdeye HİÇ koymayız (yoksa writerJson sessizce Vertex/Ollama'ya düşer, Claude hiç kullanılmaz).
// Haiku 4.5 (varsayılan) ve <=4.6 aileleri kabul eder → onlara gönderilir (repair'in determinizm/nudge'ı korunur).
// NOT: Anthropic yeni frontier modellerde bu paramları kaldırma yönünde → yeni model çıkınca buraya ekle.
const SAMPLING_REJECTED_MODEL_PREFIXES = [
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-mythos-5",
];
function modelRejectsSampling(model: string): boolean {
  const m = model.toLowerCase();
  return SAMPLING_REJECTED_MODEL_PREFIXES.some((p) => m.startsWith(p));
}

// Anahtar KODA yazılmaz — lokal .env (gitignore'lu). Boşluk-trim: "  " gibi değer configured saymaz.
export function claudeConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim());
}

// Anthropic Messages API ile şemalı JSON üretir. Nihai/dışa-dönük yazar (outreach + digest) için.
// Dönüş: { data (zod-parse edilmiş), usd (GERÇEK token maliyeti) }. usd, writerJson'un recordCost'a
// gerçek değer yazması için — AGENT_DAILY_CAP_USD guardrail'i gerçek maliyete dayanır; usd=0 cap'i baypas eder.
// Hata durumunda THROW (writerJson yakalar → sonraki sağlayıcıya fallback). Anahtar ASLA loglanmaz/exception'a girmez.
export async function claudeJson<S extends z.ZodTypeAny>(opts: {
  system: string;
  user: string;
  schema: S;
  model?: string;
  maxAttempts?: number;
  // Her ÜCRETLİ (HTTP 200) çağrıdan sonra biriken TOPLAM usd ile çağrılır. writerJson bunu HATA
  // yolunda da yakalar → tüm denemeler başarısız olup THROW etsek bile gerçekten harcanan para
  // recordCost'a yazılır (aksi halde return'e ulaşılmaz, usd kaybolur, cap baypas edilir).
  onSpend?: (usdSoFar: number) => void;
}): Promise<{ data: z.infer<S>; usd: number }> {
  const model = opts.model ?? env.ANTHROPIC_WRITER_MODEL;
  // Güçlü model nadiren bozuk JSON üretir; ama repair ağı yine değerli. Varsayılan 2 (bir onarım denemesi):
  // her retry GERÇEK para → Ollama'nın 3'ünden düşük tutuyoruz (maliyet vs dayanıklılık dengesi).
  const maxAttempts = opts.maxAttempts ?? 2;
  // Retry'ler dahil TÜM denemelerin maliyeti (her Anthropic çağrısı ücretlidir → cap doğru kalsın diye biriktir).
  let usd = 0;

  const data = await runJsonWithRepair<S>({
    schema: opts.schema,
    maxAttempts,
    // Her deneme KENDİ AbortController + timeout'unu alır; clearTimeout finally'de → timer/controller leak yok.
    generate: async ({ repairSuffix: suffix, temperature }) => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), env.ANTHROPIC_TIMEOUT_MS);
      try {
        const res = await fetch(ANTHROPIC_URL, {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY ?? "",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          signal: ctrl.signal,
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            // temperature yalnız kabul eden modellere gönderilir; 4.7+/5-ailesi 400 döndürür → hiç koyma.
            ...(modelRejectsSampling(model) ? {} : { temperature }),
            system: opts.system + JSON_ONLY_INSTRUCTION + suffix,
            messages: [{ role: "user", content: opts.user }],
          }),
        });
        if (!res.ok) {
          // Hata gövdesi (Anthropic error JSON) anahtarı içermez; header'lar mesaja ASLA konmaz.
          throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        const body = (await res.json()) as {
          content?: Array<{ type?: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        // GERÇEK maliyet: response.usage token'larından ($/1M token fiyatlarıyla). Denemeler arası biriktir.
        const inTok = body.usage?.input_tokens ?? 0;
        const outTok = body.usage?.output_tokens ?? 0;
        usd +=
          (inTok / 1_000_000) * env.ANTHROPIC_PRICE_IN_PER_MTOK +
          (outTok / 1_000_000) * env.ANTHROPIC_PRICE_OUT_PER_MTOK;
        // Ücret bu çağrıda TAHAKKUK ETTİ → biriken toplamı dışarı bildir (throw olsa bile kaydedilir).
        opts.onSpend?.(usd);
        // type==='text' bloklarını birleştir (tool/thinking blokları değil).
        return (body.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
      } finally {
        clearTimeout(to);
      }
    },
    // Gözlemlenebilirlik: yalnız deneme sayısı + hata tipi + model (PII / gövde içeriği ASLA loglanmaz).
    onRepairSuccess: (attempt) => log.info({ attempt, model }, "claude repair başarılı (JSON şema düzeltildi)"),
    onAttemptError: (attempt, kind) => log.debug({ attempt, maxAttempts, model, errKind: kind }, "claude deneme başarısız"),
  });

  return { data, usd };
}
