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
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GOOGLE_CLOUD_LOCATION: z.string().default("europe-west4"),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // --- Kontrol yüzeyi (opsiyonel: yoksa log'a düşer) ---
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  NOTION_TOKEN: z.string().optional(),

  // --- Competitor-intel ---
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  GAP_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
});

export const env = Env.parse(process.env);
export type AppEnv = z.infer<typeof Env>;
