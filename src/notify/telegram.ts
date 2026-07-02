import { env } from "../config/env";
import { childLogger } from "../core/logger";

const log = childLogger("telegram");

// Token/chat_id varsa Telegram'a gönderir; yoksa log'a düşer (graceful, kilitlenmez).
export async function notify(text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    log.info({ preview: text.slice(0, 300) }, "telegram yapılandırılmamış → log");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!res.ok) log.warn({ status: res.status }, "telegram gönderim başarısız");
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "telegram hata");
  }
}
