import { z } from "zod";

// .env varsa yükle (yoksa gerçek ortam değişkenleri kullanılır — CI/prod)
try {
  process.loadEnvFile(".env");
} catch {
  /* .env opsiyonel */
}

const Env = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL zorunlu"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  TICK_WORKER_TURNS: z.coerce.number().int().positive().default(5),
  WORKER_LEASE_SECONDS: z.coerce.number().int().positive().default(120),
  JOB_STALE_HOURS: z.coerce.number().int().positive().default(12),
  AGENT_DAILY_CAP_USD: z.coerce.number().nonnegative().default(5),

  // --- LLM (hibrit: Ollama kütle + Vertex-EU writer, yoksa lokal fallback) ---
  OLLAMA_HOST: z.string().default("http://127.0.0.1:11434"),
  OLLAMA_BULK_MODEL: z.string().default("qwen3:30b"),
  OLLAMA_WRITER_MODEL: z.string().default("qwen3:30b"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // ollamaJson() bir çağrıyı en fazla kaç kez dener (timeout / JSON-parse / zod-şema hatasında repair-reprompt ile tekrar).
  // 1 = retry yok = eski davranış (tek deneme). Her deneme KENDİ timeout'unu alır; retry'ler arası backoff YOK (lokal Ollama).
  OLLAMA_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),

  // --- Anthropic Claude (nihai/dışa-dönük yazar: outreach taslağı + haftalık digest) ---
  // Anahtar KODA yazılmaz — lokal .env'de (gitignore'lu). Yoksa writer router Vertex/Ollama'ya düşer.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_WRITER_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Haiku 4.5 fiyatları ($/1M token): girdi $1.00, çıktı $5.00 (Anthropic fiyat tablosu, 2026-06).
  // NOT: fiyatlar değişebilir → periyodik DOĞRULANMALI. Cap gerçek maliyete dayandığı için,
  // şüphedeyken yüksek tut (erken korur).
  ANTHROPIC_PRICE_IN_PER_MTOK: z.coerce.number().nonnegative().default(1.0),
  ANTHROPIC_PRICE_OUT_PER_MTOK: z.coerce.number().nonnegative().default(5.0),

  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GOOGLE_CLOUD_LOCATION: z.string().default("europe-west4"),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // --- Kontrol yüzeyi (opsiyonel: yoksa log'a düşer) ---
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  NOTION_TOKEN: z.string().optional(),
  // 'Reflektif CRM' Notion database id — sır DEĞİL (yalnız bir DB kimliği). Boş bırakılırsa notion.ts
  // kod-varsayılanını kullanır. notion-sync bu database'e enrich lead'leri yazar (lead'lere gönderim DEĞİL).
  NOTION_CRM_DATABASE_ID: z.string().default("37d27813-a60a-818a-8d4a-d737518cd5c5"),

  // --- Faz 2 (çok-kanal gönderim) — hazır ama RED tier: kod aktive edilene kadar okunmaz ---
  SENDING_DOMAIN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),

  // --- Competitor-intel ---
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  GAP_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),

  // --- Lead sourcing ---
  SOURCE_MAX_CANDIDATES_PER_RUN: z.coerce.number().int().positive().default(40),
  // enrich: ana sayfadan keşfedilen iletişim/kariyer alt-sayfalarından en fazla kaç tanesi taranır (tek-hop).
  LEADGEN_MAX_CONTACT_PAGES: z.coerce.number().int().positive().default(3),

  // --- Email doğrulama (MillionVerifier) — GÖNDERİM DEĞİL; yalnız lead_contacts.email_status'u set eder (Green tier) ---
  // Anahtar KODA yazılmaz — kasada + lokal .env'de (gitignore'lu). Yoksa verifyEmail graceful 'unknown' döner.
  EMAIL_VERIFY_API_KEY: z.string().optional(),
  EMAIL_VERIFY_PROVIDER: z.string().default("millionverifier"),
  EMAIL_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Kalan kredi bunun ALTINA düşünce API'yi bir daha çağırma → 'unknown' (kredi tükenmesini önle).
  EMAIL_VERIFY_MIN_CREDITS: z.coerce.number().int().nonnegative().default(25),
});

export const env = Env.parse(process.env);
export type AppEnv = z.infer<typeof Env>;
