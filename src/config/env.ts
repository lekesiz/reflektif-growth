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
});

export const env = Env.parse(process.env);
export type AppEnv = z.infer<typeof Env>;
