import { Agent, fetch as undiciFetch } from "undici";
import { constants as cryptoConstants } from "node:crypto";
import { env } from "../config/env";

// TR kurumsal siteler (.edu.tr/.gov.tr) sık sık eksik sertifika zinciri (UNABLE_TO_VERIFY_LEAF_SIGNATURE),
// eski TLS renegotiation ya da h2 kullanır — Node/undici varsayılanı bunları reddeder (curl tolere eder),
// bu da tam-ICP hedeflerde ciddi yield kaybı demek.
//
// GÜVENLİK NOTU: rejectUnauthorized:false YALNIZ bu read-only crawler ajanına özeldir (global dispatcher
// DEĞİL) → DB ve diğer tüm çağrılar katı TLS'te kalır. Bu crawler public sayfaları ziyaretçi gibi okur;
// hiç sır GÖNDERMEZ ve gelen içerik zaten "güvenilmez veri" (prompt-injection'a karşı ele alınır).
const crawlAgent = new Agent({
  allowH2: true,
  connect: {
    rejectUnauthorized: false,
    secureOptions: cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT,
  },
  connectTimeout: env.FETCH_TIMEOUT_MS,
});

const UA = "reflektif-growth-bot/0.1 (+https://reflektif.info)";

// Ham gövde (TLS-toleranslı). Hata/timeout → status 0 (çağıran graceful ele alır; asla throw etmez).
// finalUrl: redirect:"follow" sonrası GERÇEK sayfa URL'i — relative link çözümü ve evidence_url için
// istek atılan (redirect-öncesi) url yerine bu kullanılmalı.
export async function fetchRaw(url: string, maxBytes = 2_000_000): Promise<{ status: number; body: string; finalUrl: string }> {
  try {
    const res = await undiciFetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(env.FETCH_TIMEOUT_MS),
      redirect: "follow",
      dispatcher: crawlAgent,
    });
    return { status: res.status, body: (await res.text()).slice(0, maxBytes), finalUrl: res.url || url };
  } catch {
    return { status: 0, body: "", finalUrl: url };
  }
}
