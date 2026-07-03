import { env } from "../config/env";
import { childLogger } from "../core/logger";

// Notion 'Reflektif CRM' senkronu (BİZİM CRM'imize yazma — lead'lere gönderim DEĞİL).
// İDEMPOTENT + TAHRİBATSIZ: aynı Website'e sahip bir sayfa varsa ASLA dokunmaz (kullanıcının manuel
// kayıtları — Koç Holding vb. — ezilmez); yoksa yeni sayfa oluşturur. Token ASLA loglanmaz.
const log = childLogger("notion");

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
// 'Reflektif CRM' database_id (doğrulandı). env.NOTION_CRM_DATABASE_ID boşsa bu kod-varsayılanı kullanılır.
const DEFAULT_DB_ID = "37d27813-a60a-818a-8d4a-d737518cd5c5";
// Rate-limit: Notion ~3 req/s. Her isteğin arasına en az bu kadar bekle (basit tek-akış throttle).
const MIN_INTERVAL_MS = 350;
// Notion rich_text/title tek blok içerik üst sınırı (2000 char); taşarsa API 400 döndürür → kırp.
const MAX_TEXT = 2000;

export interface NotionLead {
  companyName: string; // 'Platform/Kurum' (title)
  domain: string; // 'Website' url'i https://domain'e çevrilir
  segment: string | null; // 'Kategori' eşlemesinde kullanılır
  icpScore: number | null; // 'Öncelik' eşiği
  whyNow: string | null; // 'Notlar' (signals->>'why_now')
  evidenceUrl: string | null; // 'Notlar' (Kaynak:)
  email: string | null; // 'Email' (jenerik kurumsal kutu; yoksa boş)
  draftSubject: string | null; // varsa 'Durum'=Hazırlanıyor + 'Notlar' (Taslak:)
}

export interface NotionUpsertResult {
  pageId: string; // oluşturulan YA DA bulunan mevcut sayfanın id'si
  created: boolean; // true = biz oluşturduk; false = mevcut (manuel) sayfa bulundu, DOKUNULMADI
}

// Token trim edilir; "  " gibi boş değer configured saymaz (telegram/claude deseniyle uyumlu).
export function notionConfigured(): boolean {
  return Boolean(env.NOTION_TOKEN && env.NOTION_TOKEN.trim());
}

function databaseId(): string {
  return (env.NOTION_CRM_DATABASE_ID && env.NOTION_CRM_DATABASE_ID.trim()) || DEFAULT_DB_ID;
}

// domain/URL → kanonik bare host: protokol + baştaki www + path/query/fragment + case arındırılır.
// Hem WRITE (https://host) hem de DEDUP karşılaştırması bunu kullanır; böylece www/http/trailing-slash/
// path/case varyantları AYNI kanonik host'a iner (manuel kayıtların duplikasyonu önlenir).
export function websiteHost(input: string): string {
  const h = (input || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0]; // path/query/fragment'i at → yalın host
  return (h ?? "").toLowerCase();
}

// domain → kanonik Website url'i (https://host). leadgen sourcing domainleri zaten www'suz saklar;
// burada kanonikleştirerek idempotent sorgu için tutarlı tek bir kanonik URL üretiriz.
export function websiteUrl(domain: string): string {
  return `https://${websiteHost(domain)}`;
}

// ----- eşleme (saf, deterministik) — select'e OLMAYAN değer ÜRETME (Notion yeni option üretip pollute eder) -----

// Kategori: domain önce (.edu.tr/.k12.tr otoriter), sonra segment. Emin değilsen BOŞ (null) bırak.
export function mapKategori(domain: string, segment: string | null): string | null {
  const d = (domain || "").toLowerCase();
  if (d.endsWith(".edu.tr")) return "Üniversite";
  if (d.endsWith(".k12.tr")) return "Okul";
  if (segment === "b2b_pro") return "Koçluk";
  if (segment === "b2b2c_ld") return "İK Yazılım";
  if (segment === "b2b_edu") return "Üniversite";
  return null; // b2c / bilinmiyor → yanlış option üretme, BOŞ
}

// Öncelik: icp_score eşiği. Not: 'P0+' option'ı vardır ama otomatik ATANMAZ (yalnız manuel).
export function mapOncelik(icp: number | null): "P0" | "P1" | "P2" | "P3" {
  const s = icp ?? 0;
  if (s >= 85) return "P0";
  if (s >= 75) return "P1";
  if (s >= 60) return "P2";
  return "P3";
}

// Durum: taslak varsa 'Hazırlanıyor', yoksa 'Araştırılacak'. ASLA 'Email Gönderildi' (göndermiyoruz).
export function mapDurum(hasDraft: boolean): "Hazırlanıyor" | "Araştırılacak" {
  return hasDraft ? "Hazırlanıyor" : "Araştırılacak";
}

// Notlar: why_now + (varsa) '\nKaynak: '+evidence_url + (varsa) '\nTaslak: '+subject.
export function buildNotlar(lead: NotionLead): string {
  const lines: string[] = [];
  if (lead.whyNow && lead.whyNow.trim()) lines.push(lead.whyNow.trim());
  if (lead.evidenceUrl) lines.push(`Kaynak: ${lead.evidenceUrl}`);
  if (lead.draftSubject) lines.push(`Taslak: ${lead.draftSubject}`);
  return lines.join("\n");
}

// lead → Notion 'Reflektif CRM' properties. Sadece MEVCUT kolonlara/select değerlerine yazar.
function buildProperties(lead: NotionLead): Record<string, unknown> {
  const props: Record<string, unknown> = {
    "Platform/Kurum": { title: [{ text: { content: (lead.companyName || websiteUrl(lead.domain)).slice(0, MAX_TEXT) } }] },
    Website: { url: websiteUrl(lead.domain) },
    Öncelik: { select: { name: mapOncelik(lead.icpScore) } },
    Durum: { select: { name: mapDurum(Boolean(lead.draftSubject)) } },
    Notlar: { rich_text: [{ text: { content: buildNotlar(lead).slice(0, MAX_TEXT) } }] },
    Sahip: { select: { name: "Mikail" } },
  };
  const kategori = mapKategori(lead.domain, lead.segment);
  if (kategori) props["Kategori"] = { select: { name: kategori } }; // BOŞsa hiç yazma (yanlış option üretme)
  if (lead.email && lead.email.trim()) props["Email"] = { email: lead.email.trim() };
  return props;
}

// ----- HTTP (token ASLA loglanmaz; hata → throw; ~3 req/s throttle) -----
let lastReqAt = 0;
async function throttle(): Promise<void> {
  const wait = lastReqAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReqAt = Date.now();
}

async function notionPost(path: string, body: unknown): Promise<Response> {
  await throttle();
  return fetch(`${NOTION_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN ?? ""}`,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify(body),
  });
}

// 'Reflektif CRM'e lead yaz. İDEMPOTENT + TAHRİBATSIZ:
//  1) Website=url ile sayfa VAR MI diye sorar → varsa DOKUNMAZ (manuel kayıt korunur), created:false döner.
//  2) yoksa yeni sayfa OLUŞTURUR → created:true + page_id döner.
// Hata → throw (çağıran yakalar + audit'ler). Notion hata gövdesi token içermez; yine de mesaj kırpılır.
export async function notionUpsertLead(lead: NotionLead): Promise<NotionUpsertResult> {
  if (!notionConfigured()) throw new Error("NOTION_TOKEN yapılandırılmamış");
  const dbId = databaseId();
  const host = websiteHost(lead.domain);
  if (!host) throw new Error("notion upsert: domain boş/geçersiz");
  const url = `https://${host}`;

  // İDEMPOTENT + TAHRİBATSIZ dedup: Notion 'url equals' filtresi TAM string eşleşmesidir (normalize etmez),
  // bu yüzden www/http/trailing-slash/path varyantı olan manuel kayıtları KAÇIRIR ve duplicate üretir.
  // Çözüm: 'contains host' ile aday sayfaları çek (varyantları yakalar), sonra KODDA kanonik host eşitliğiyle
  // doğrula (contains substring yanlış-pozitifini — örn. 'notkoc.com.tr' ⊃ 'koc.com.tr' — ele).
  const qRes = await notionPost(`/databases/${dbId}/query`, {
    filter: { property: "Website", url: { contains: host } },
    page_size: 100,
  });
  if (!qRes.ok) throw new Error(`notion query ${qRes.status}: ${(await qRes.text()).slice(0, 300)}`);
  const qBody = (await qRes.json()) as {
    results?: Array<{ id?: string; properties?: { Website?: { url?: string | null } } }>;
  };
  const match = qBody.results?.find((p) => websiteHost(p.properties?.Website?.url ?? "") === host);
  if (match?.id) {
    // TAHRİBATSIZ: mevcut sayfaya ASLA yazma/güncelleme yapma (kullanıcının manuel kaydı olabilir).
    log.info({ website: url }, "notion: mevcut sayfa bulundu → DOKUNULMADI");
    return { pageId: match.id, created: false };
  }

  const cRes = await notionPost(`/pages`, { parent: { database_id: dbId }, properties: buildProperties(lead) });
  if (!cRes.ok) throw new Error(`notion create ${cRes.status}: ${(await cRes.text()).slice(0, 300)}`);
  const cBody = (await cRes.json()) as { id?: string };
  if (!cBody.id) throw new Error("notion create: page id dönmedi");
  return { pageId: cBody.id, created: true };
}
