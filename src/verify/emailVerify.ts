import { env } from "../config/env";
import { childLogger } from "../core/logger";

// MillionVerifier v3 email-verify entegrasyonu — SADECE email_status'u set eder.
// GÖNDERİM YOK: canSend / deny-by-default / draft_for_review bu modülden ETKİLENMEZ.
// TASARIM: verifyEmail ASLA throw ETMEZ (hata/timeout/anahtar-yok → graceful 'unknown') → verify job'ı patlamaz.
// GÜVENLİK: API anahtarı yalnız query string'de gider; ASLA loglanmaz (hata mesajına da konmaz — bu yüzden
// yakalanan hata nesnesi hiç loglanmaz, çünkü undici hata mesajı URL'i = token'ı içerebilir).
const log = childLogger("email-verify");

// GET https://api.millionverifier.com/api/v3/?api=<KEY>&email=<email>&timeout=<sn>
const MV_API = "https://api.millionverifier.com/api/v3/";
// Rate-limit: ~5 req/s → her isteğin arasına en az bu kadar bekle (Notion deseniyle aynı basit tek-akış throttle).
const MIN_INTERVAL_MS = 200;

export type EmailStatus = "valid" | "risky" | "invalid" | "unknown";

// MillionVerifier `result` alanı JSON şeması:
//   ok, catch_all, unknown, disposable, invalid, error, ... (ileride yeni değerler gelebilir → default 'unknown')
export interface MvResponse {
  result?: string;
  quality?: string;
  credits?: number;
  resultcode?: number;
}

export interface VerifyResult {
  status: EmailStatus;
  credits?: number;
}

// EŞLEME (saf, deterministik — ağsız test edilebilir):
//   ok         → valid    (var olan, teslim edilebilir kutu)
//   catch_all  → risky    (domain her adresi kabul eder; kutunun VAR OLDUĞU KANITLANAMAZ → 'valid' DEĞİL)
//   disposable → invalid  (tek-kullanımlık; hedeflenmez)
//   invalid    → invalid
//   unknown / error / diğer → unknown
export function mapResult(result: string | undefined): EmailStatus {
  switch ((result ?? "").trim().toLowerCase()) {
    case "ok":
      return "valid";
    case "catch_all":
      return "risky";
    case "disposable":
      return "invalid";
    case "invalid":
      return "invalid";
    default:
      return "unknown"; // unknown, error ve tanınmayan tüm değerler
  }
}

// Anahtar trim edilir; "   " gibi boş değer configured saymaz (notion/telegram deseniyle uyumlu).
export function emailVerifyConfigured(): boolean {
  return Boolean(env.EMAIL_VERIFY_API_KEY && env.EMAIL_VERIFY_API_KEY.trim());
}

// ~5 req/s throttle (tek-akış worker; module-level).
let lastReqAt = 0;
async function throttle(): Promise<void> {
  const wait = lastReqAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReqAt = Date.now();
}

// KREDİ-GUARD: son görülen kalan-kredi. env.EMAIL_VERIFY_MIN_CREDITS'in ALTINA düşünce API'yi bir daha ÇAĞIRMA
// (kredi tükenmesini önle) → doğrudan 'unknown' dön. Yeni kredi ancak konfigürasyon/kredi eklendikçe artar;
// process yeniden başlayınca sıfırlanır (yeni bir çağrı gerçek krediyi tekrar öğrenir).
let lastCredits: number | null = null;
let lowCreditWarned = false;

// Tek e-postayı doğrula. ASLA throw etmez; hata/timeout/anahtar-yok/kredi-düşük → { status: 'unknown' }.
export async function verifyEmail(email: string): Promise<VerifyResult> {
  if (!emailVerifyConfigured()) return { status: "unknown" };
  // Yalnız MillionVerifier desteklenir; yanlış provider konfigüre edilmişse yanlış endpoint'e kredi harcama.
  if (env.EMAIL_VERIFY_PROVIDER.trim().toLowerCase() !== "millionverifier") {
    return { status: "unknown" };
  }
  // KREDİ-GUARD: floor altındaysa API'yi HİÇ çağırma.
  if (lastCredits !== null && lastCredits < env.EMAIL_VERIFY_MIN_CREDITS) {
    return { status: "unknown", credits: lastCredits };
  }

  try {
    await throttle();
    const key = (env.EMAIL_VERIFY_API_KEY ?? "").trim();
    // API 'timeout' saniye cinsindendir; client abort'u biraz DAHA uzun tut ki sunucunun kendi timeout'u baskın
    // gelsin (client abort'u erken tetiklenip yanıtı kaçırmasın).
    const timeoutSec = Math.max(2, Math.round(env.EMAIL_VERIFY_TIMEOUT_MS / 1000));
    const url = `${MV_API}?api=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&timeout=${timeoutSec}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(env.EMAIL_VERIFY_TIMEOUT_MS + 5_000) });
    // Non-2xx → 'unknown' (token loglama: gövde/mesaj yazma, URL'i asla logla).
    if (!res.ok) {
      log.warn({ httpStatus: res.status }, "email-verify: non-2xx → unknown");
      return { status: "unknown" };
    }
    const body = (await res.json()) as MvResponse;
    const credits = typeof body.credits === "number" ? body.credits : undefined;
    if (credits !== undefined) {
      lastCredits = credits;
      if (credits < env.EMAIL_VERIFY_MIN_CREDITS && !lowCreditWarned) {
        lowCreditWarned = true; // tek sefer uyar (her çağrıda spam etme)
        log.warn(
          { credits, floor: env.EMAIL_VERIFY_MIN_CREDITS },
          "email-verify: kalan kredi eşiğin ALTINDA — sonraki çağrılar API'ye gitmeden 'unknown' davranacak",
        );
      } else if (credits >= env.EMAIL_VERIFY_MIN_CREDITS) {
        lowCreditWarned = false; // kredi tekrar yükseldiyse uyarıyı sıfırla
      }
    }
    return { status: mapResult(body.result), credits };
  } catch {
    // timeout / ağ / parse hatası — ASLA throw etme, ASLA token içeren hatayı loglama.
    log.warn("email-verify: çağrı başarısız → unknown");
    return { status: "unknown" };
  }
}
