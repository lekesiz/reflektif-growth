import { z } from "zod";
import type { Handler } from "../core/handler";
import { query } from "../db/pool";
import { env } from "../config/env";
import { audit } from "../core/audit";
import { enqueue } from "../core/queue";
import { assertLeadTransition } from "../core/stateMachine";
import { markIfChanged } from "../core/seen";
import { fetchRaw } from "../core/http";
import { bulkJson, writerJson } from "../llm/index";
import { childLogger } from "../core/logger";

const log = childLogger("leadgen");

// ----- yardımcılar -----
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return " "; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return " "; } })
    .replace(/&([a-z]+);/gi, (_, n) => NAMED_ENTITIES[String(n).toLowerCase()] ?? " ");
}
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}
// <title> içeriği — kurumun kendi sayfasından otoriter isim (sourcing anchor-metni gürültülü olabilir).
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  // "Anasayfa | X Üniv." / "X Üniv. | slogan" → ayraçlarla böl, İLK anlamlı parça (genelde kurum adı).
  const full = htmlToText(m[1] ?? "");
  const parts = full
    .split(/\s[|»\-–—:]\s/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && !/^(ana ?sayfa|home|anasayfa|welcome|hoş ?geldiniz)$/i.test(s));
  return (parts[0] ?? full).slice(0, 120);
}

// Ham HTML (link'ler + <title> için; TLS-toleranslı crawler fetch — TR kurumsal siteler için).
// finalUrl: redirect sonrası gerçek sayfa URL'i (relative link çözümü / evidence_url için url yerine kullanılmalı).
async function fetchHtml(url: string): Promise<{ status: number; html: string; finalUrl: string }> {
  const { status, body, finalUrl } = await fetchRaw(url);
  return { status, html: body, finalUrl };
}

const GENERIC_LOCALS = ["info", "bilgi", "iletisim", "ik", "kariyer", "insankaynaklari", "destek", "contact", "hello", "admin", "kayit", "ogrenci"];
// Teknik/otomatik kutular — hiçbir segmentte aday olmamalı (insan yok, KVKK açısından da anlamsız hedef).
// local, karşılaştırmadan önce '.'/'-'/'_' ayraçlarından arındırılır (ör. "no-reply-tr", "webmaster.bounce" de yakalanır).
const TECHNICAL_LOCALS = ["noreply", "donotreply", "postmaster", "webmaster", "abuse", "mailerdaemon", "bounce", "bounces", "unsubscribe", "optout"];
function extractEmails(text: string, domain: string): Array<{ email: string; generic: boolean }> {
  const bare = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const out: Array<{ email: string; generic: boolean }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    const email = m[0].toLowerCase();
    if (seen.has(email) || !email.includes(bare)) continue;
    seen.add(email);
    const local = email.split("@")[0] ?? "";
    const localNorm = local.replace(/[.\-_]/g, "");
    if (TECHNICAL_LOCALS.some((t) => localNorm === t || localNorm.startsWith(t))) continue;
    out.push({ email, generic: GENERIC_LOCALS.some((g) => local === g || local.startsWith(g)) });
  }
  return out;
}

// ----- sourcing: dizin sayfasından kurum linki çıkarımı (saf, deterministik) -----
// Sosyal/altyapı/CDN host'ları — lead değil. Suffix eşleşmesi (subdomain'leri de yakalar).
const INFRA_HOSTS = [
  "facebook.com", "twitter.com", "x.com", "instagram.com", "linkedin.com", "youtube.com", "youtu.be",
  "whatsapp.com", "wa.me", "t.me", "telegram.me", "pinterest.com", "tiktok.com", "apple.com",
  "google.com", "goo.gl", "gstatic.com", "googleapis.com", "googletagmanager.com", "google-analytics.com",
  "w3.org", "schema.org", "creativecommons.org", "gnu.org", "mozilla.org", "jquery.com", "bootstrapcdn.com",
  "wikimedia.org", "wikidata.org", "mediawiki.org", "archive.org", "doi.org", "worldcat.org",
];
function isInfraHost(host: string): boolean {
  return INFRA_HOSTS.some((h) => host === h || host.endsWith("." + h));
}
// TR/ccTLD ikinci-seviye alan adları — registrable domain'i 3 parçaya çıkar (ör. itu.edu.tr).
const CCTLD_SLD = new Set(["com", "org", "net", "edu", "gov", "gen", "av", "dr", "bel", "pol", "tsk", "k12", "mil", "co", "ac"]);
function registrable(host: string): string {
  const p = host.split(".");
  if (p.length <= 2) return host;
  const tld = p.at(-1) ?? "";
  if (tld.length === 2 && CCTLD_SLD.has(p.at(-2) ?? "")) return p.slice(-3).join(".");
  return p.slice(-2).join(".");
}

export interface OrgCandidate {
  name: string;
  domain: string;
}

// HTML'den dış kurum linklerini çıkar. domainFilter (JS-regex) verilirse yalnız eşleşen host'lar
// aday olur (naif "tüm dış linkler" gürültüsünü keser). Kaynağın kendi domain'i + altyapı host'ları elenir.
// excludeFilter (JS-regex): host bununla eşleşirse aday ELENİR — dizinde karışan dernek-ekosistemi/
// web-ajansı/gov host'larını temizler (domainFilter/infra/iç-link elemesine EK negatif filtre).
export function extractOrgLinks(html: string, sourceUrl: string, domainFilter?: string | null, excludeFilter?: string | null): OrgCandidate[] {
  let filter: RegExp | null = null;
  if (domainFilter) {
    try {
      filter = new RegExp(domainFilter, "i");
    } catch {
      filter = null; // bozuk regex → filtre yok (fail-open; downstream enrich yine ICP süzer)
    }
  }
  let exclude: RegExp | null = null;
  if (excludeFilter) {
    try {
      exclude = new RegExp(excludeFilter, "i");
    } catch {
      exclude = null; // bozuk regex → exclude yok (fail-open; gürültü sızsa bile ICP süzer)
    }
  }
  let srcReg = "";
  try {
    srcReg = registrable(new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, ""));
  } catch {
    /* geçersiz sourceUrl → iç-link elemesi atlanır */
  }
  const out: OrgCandidate[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const href = m[1] ?? "";
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let host: string;
    try {
      const u = new URL(href, sourceUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      host = u.hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (!host.includes(".") || /^\d+(\.\d+){3}$/.test(host)) continue;
    if (srcReg && (host === srcReg || host.endsWith("." + srcReg))) continue; // iç link
    if (isInfraHost(host)) continue;
    if (filter && !filter.test(host)) continue;
    if (exclude && exclude.test(host)) continue; // per-kaynak gürültü elemesi (dernek/ajans/gov host'ları)
    if (seen.has(host)) continue;
    seen.add(host);
    const name = htmlToText(m[2] ?? "").slice(0, 200) || host;
    out.push({ name, domain: host });
  }
  return out;
}

// ----- enrich: iletişim/kariyer alt-sayfa keşfi (saf, deterministik; tek-hop) -----
const CONTACT_KEYWORDS = ["iletisim", "contact", "kariyer", "career", "insan-kaynaklari", "human-resources", "hr", "ik"];
// TR aksan kırma — keyword listesi aksansız (ör. "iletisim"); anchor metni "İletişim" gibi aksanlı olabilir.
function stripTrAccents(s: string): string {
  return s
    .toLowerCase()
    // JS'in locale-bağımsız toLowerCase()'i büyük "İ" (U+0130) harfini düz "i" değil,
    // "i" + birleştirici nokta-üstü işareti (U+0307) yapar — bu işareti at (aksi halde
    // "İletişim"/"İK" gibi metinler CONTACT_KEYWORDS ile hiç eşleşmez).
    .replace(/\u0307/g, "")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u");
}
function looksLikeContactLink(href: string, linkText: string): boolean {
  const hay = stripTrAccents(href) + " " + stripTrAccents(linkText);
  return CONTACT_KEYWORDS.some((k) => hay.includes(k));
}

// Ana sayfa HTML'inden iletişim/kariyer alt-sayfa URL'lerini bul (registrable domain'e göre extractOrgLinks
// ile aynı iç/dış ayrımını paylaşır). Aday çıkmazsa yaygın yolları fallback dener. Recursive DEĞİL (tek-hop).
export function discoverContactPaths(html: string, baseUrl: string): string[] {
  let baseReg = "";
  try {
    baseReg = registrable(new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, ""));
  } catch {
    return []; // geçersiz baseUrl → aday yok
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    if (out.length >= env.LEADGEN_MAX_CONTACT_PAGES) break;
    const href = m[1] ?? "";
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    if (!looksLikeContactLink(href, htmlToText(m[2] ?? ""))) continue;
    let abs: URL;
    try {
      abs = new URL(href, baseUrl);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    } catch {
      continue;
    }
    if (registrable(abs.hostname.toLowerCase().replace(/^www\./, "")) !== baseReg) continue; // yalnız aynı kurum
    abs.hash = "";
    const url = abs.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  if (out.length > 0) return out;
  // Fallback: link taramasından hiç aday çıkmadıysa yaygın yolları dene (yine baseUrl'e göre çözülür, aynı üst sınır).
  const fallback: string[] = [];
  for (const p of ["/iletisim", "/contact", "/kariyer"]) {
    if (fallback.length >= env.LEADGEN_MAX_CONTACT_PAGES) break;
    try {
      fallback.push(new URL(p, baseUrl).toString());
    } catch {
      /* geçersiz baseUrl zaten yukarıda elendi */
    }
  }
  return fallback;
}

// Deny-by-default gönderim kapısı (Faz 3 send'in kullanacağı; Faz 1b'de sadece HESAPLANIR).
export async function canSend(email: string): Promise<{ ok: boolean; reason?: string }> {
  if ((await query(`select 1 from suppression_list where email=$1`, [email])).rowCount) return { ok: false, reason: "suppressed" };
  const row = (await query<{ email_status: string; lawful: boolean }>(`select email_status, lawful from lead_contacts where email=$1`, [email])).rows[0];
  if (!row) return { ok: false, reason: "unknown-contact" };
  if (row.email_status !== "valid") return { ok: false, reason: `email_status=${row.email_status}` };
  return { ok: true };
}

// ----- leadgen:source (dizin sayfası → yeni lead_companies + enrich enqueue; GÖNDERİM YOK) -----
interface SourceRow {
  id: number;
  name: string;
  url: string;
  domain_filter: string | null;
  exclude_domains: string | null;
}

export const leadgenSource: Handler = async (job) => {
  const sourceId = Number((job.payload as { sourceId?: number }).sourceId);
  const s = (
    await query<SourceRow>(`select id,name,url,domain_filter,exclude_domains from lead_sources where id=$1 and active=true`, [sourceId])
  ).rows[0];
  if (!s) return { costUsd: 0 };
  const { status, html } = await fetchHtml(s.url);
  if (status !== 200 || !html) {
    await audit({ loop: "leadgen", action: "source.fetch_failed", target: s.name, detail: { url: s.url, status } });
    return { costUsd: 0 };
  }
  // Dizin değişmediyse tekrar taramaya gerek yok (maliyet+gürültü); mevcut adaylar zaten pipeline'da.
  if (!(await markIfChanged(`source:${s.id}`, html))) {
    await audit({ loop: "leadgen", action: "source.unchanged", target: s.name });
    return { costUsd: 0 };
  }
  const candidates = extractOrgLinks(html, s.url, s.domain_filter, s.exclude_domains).slice(0, env.SOURCE_MAX_CANDIDATES_PER_RUN);
  let added = 0;
  for (const c of candidates) {
    const ins = await query<{ id: number }>(
      `insert into lead_companies(name, domain, source, region, evidence_url)
       values ($1,$2,$3,'TR',$4) on conflict (domain) do nothing returning id`,
      [c.name, c.domain, `dizin:${s.name}`, s.url],
    );
    const id = ins.rows[0]?.id;
    if (id) {
      added++;
      await enqueue({ loop: "leadgen", kind: "leadgen:enrich", payload: { companyId: id }, dedupeKey: `enrich:${c.domain}` });
    }
  }
  await audit({ loop: "leadgen", action: "source.done", target: s.name, detail: { found: candidates.length, added } });
  log.info({ source: s.name, found: candidates.length, added }, "sourcing tamam");
  return { costUsd: 0 };
};

// ----- leadgen:enrich -----
// Esnek: sparse sitede model bazı alanları boş bırakabilir → default'la (kod normalize eder).
const EnrichSchema = z.object({
  segment: z.string().default("b2c"),
  entity_type: z.string().default("bilinmiyor"),
  icp_score: z.coerce.number().default(0),
  why_now: z.string().default(""),
});
const SEGMENTS = ["b2b_edu", "b2b2c_ld", "b2b_pro", "b2c"] as const;
export function normSegment(s: string): "b2b_edu" | "b2b2c_ld" | "b2b_pro" | "b2c" {
  // Model prompt'ta istenen literal enum değerini birebir döndürebilir — heuristiklerden önce buna güven.
  const raw = s.trim() as (typeof SEGMENTS)[number];
  if ((SEGMENTS as readonly string[]).includes(raw)) return raw;
  // toLocaleLowerCase("tr"): düz .toLowerCase() Türkçe büyük "İ"yi "i̇" (nokta + birleşik işaret) yapar,
  // bu da "İK" gibi kısaltmaların "ik" alt-dizesiyle eşleşmesini engeller.
  const t = s.toLocaleLowerCase("tr");
  // 2-3 harfli kısaltmalar (ik/hr/ld/l&d) tüm-kelime olarak eşleşmeli — aksi halde "psikolog", "teknik" gibi
  // alakasız kelimelerin içinde alt-dize olarak yanlışlıkla yakalanırlar.
  const words = t.split(/[^a-zçğıöşü0-9&]+/).filter(Boolean);
  if (t.includes("edu") || t.includes("okul") || t.includes("üniv") || t.includes("univ") || t.includes("school")) return "b2b_edu";
  // Kurumsal/tüzel-kişilik göstergesi ÖNCE kontrol edilir: 'bağımsız'/'koç'/'serbest' gibi bireysel-profesyonel
  // anahtar kelimeleri kurumsal metinlerle çakışır (ör. "bağımsız İK danışmanlığı", "bağımsız denetim A.Ş.",
  // "Koç Holding", "serbest bölge kurumsal ..."); bu çakışma varsa kurumsal sınıflandırma kazanmalı.
  if (words.includes("ld") || words.includes("l&d") || words.includes("ik") || words.includes("hr") || t.includes("kurum") || t.includes("a.ş") || t.includes("denetim")) return "b2b2c_ld";
  // Bağımsız/serbest bireysel profesyonel (kurum değil). NOT: 'danışman'/'danışmanlık' KASITLI olarak
  // burada YOK — bunlar kurumsal danışmanlık firmalarıyla (b2b2c_ld) çakışır, yanlış segment sızıntısı yaratır.
  if (t.includes("koç") || t.includes("coach") || t.includes("psikolog") || t.includes("terapist") || t.includes("bağımsız") || t.includes("bagimsiz") || t.includes("serbest")) return "b2b_pro";
  return "b2c";
}
function normEntity(s: string): "tacir" | "kamu" | "birey" | "bilinmiyor" {
  const t = s.toLowerCase();
  if (t.includes("kamu") || t.includes("devlet") || t.includes("public")) return "kamu";
  if (t.includes("tacir") || t.includes("şirket") || t.includes("sirket") || t.includes("private") || t.includes("özel")) return "tacir";
  if (t.includes("birey")) return "birey";
  return "bilinmiyor";
}

export const leadgenEnrich: Handler = async (job) => {
  const companyId = Number((job.payload as { companyId?: number }).companyId);
  // Kaynağın segment_hint'i (varsa) prior olarak sınıflamaya beslenir. Lead 'dizin:<name>' kaynağından
  // gelmişse ilgili lead_sources satırına join eder; manuel/hint'siz lead'de null → davranış eskisi gibi.
  const c = (
    await query<{ id: number; name: string; domain: string | null; segment_hint: string | null }>(
      `select c.id, c.name, c.domain,
              (select ls.segment_hint from lead_sources ls where 'dizin:' || ls.name = c.source limit 1) as segment_hint
         from lead_companies c where c.id=$1`,
      [companyId],
    )
  ).rows[0];
  if (!c || !c.domain) return { costUsd: 0 };
  const reqUrl = c.domain.startsWith("http") ? c.domain : `https://${c.domain}`;
  const { status, html, finalUrl: url } = await fetchHtml(reqUrl); // url: redirect sonrası GERÇEK sayfa URL'i (base + evidence_url için kullanılır)
  if (status !== 200 || !html) {
    await audit({ loop: "leadgen", action: "enrich.fetch_failed", target: c.name, detail: { url: reqUrl, status } });
    return { costUsd: 0 };
  }
  const text = htmlToText(html).slice(0, 20_000);
  // Kurumun kendi <title>'ı = otoriter isim (sourcing anchor-metni gürültülü olabilir).
  const orgName = extractTitle(html) || c.name;
  // Kaynak ipucu (segment_hint) varsa yumuşak bir PRIOR olarak eklenir; içerik açıkça farklıysa içerik kazanır.
  // Nihai karar yine KOD-KAPISI normSegment()'te; LLM yalnız önerir (AGENTS.md §4).
  const prior = c.segment_hint
    ? `\nKAYNAK İPUCU: bu lead '${c.segment_hint}' segmentli bir dizinden geldi — içerik bunu DOĞRULUYORSA bu segmenti tercih et; içerik açıkça farklıysa İÇERİĞE uy (ipucu zorlayıcı değil).`
    : "";
  const cls = await bulkJson({
    loop: "leadgen",
    jobId: job.id,
    schema: EnrichSchema,
    system:
      "Sen Reflektif (kariyer-rehberlik/bilan SaaS) için lead nitelendiricisin. Verilen kurumun public site metninden sınıflandır. Uydurma; yalnız metne dayan.\n" +
      "JSON: {segment, entity_type, icp_score, why_now}. segment ∈ {b2b_edu, b2b2c_ld, b2b_pro, b2c}.\n" +
      "SEGMENT TANIMLARI:\n" +
      "- b2b_pro = TEK bir gerçek kişinin kendi adıyla yürüttüğü BİREYSEL profesyonel pratik: bağımsız/serbest kariyer koçu, psikolojik danışman/psikolog, terapist. Aracı bizzat kendisi kullanır; şirket/kurum DEĞİL (unvan+kişi adı ağırlıkta, 'A.Ş.'/'Ltd.'/kurumsal 'biz' anlatısı YOK).\n" +
      "- b2b2c_ld = kurumsal İK / yetenek / L&D / danışmanlık ŞİRKETİ ya da çok-çalışanlı tüzel kişilik (Reflektif'i müşterilerine/çalışanlarına sunacak aracı kurum).\n" +
      "- b2b_edu = üniversite/okul/eğitim kurumu (kariyer merkezi vb.).\n" +
      "- b2c = yukarıdakilerin hiçbiri (son-kullanıcı/genel).\n" +
      "AYIRT EDİCİ ÖRNEKLER: 'Uzm. Psikolog Ayşe X - bireysel terapi' → b2b_pro; 'X Kurumsal İK Danışmanlığı A.Ş.' → b2b2c_ld.\n" +
      "entity_type ∈ {tacir, kamu, birey, bilinmiyor}. icp_score 0-100 SAYI (Reflektif'e uygunluk). why_now = neden şimdi iyi hedef (TR, kısa)." +
      prior,
    user: `KURUM: ${orgName}\nURL: ${url}\n--- İÇERİK ---\n${text.slice(0, 6000)}`,
  });
  const icp = Math.max(0, Math.min(100, Math.round(cls.icp_score)));
  const segment = normSegment(cls.segment);
  const entityType = normEntity(cls.entity_type);
  await query(`update lead_companies set name=$2, segment=$3, entity_type=$4, icp_score=$5, signals=$6, evidence_url=$7 where id=$1`, [
    companyId,
    orgName,
    segment,
    entityType,
    icp,
    JSON.stringify({ why_now: cls.why_now }),
    url,
  ]);
  // Tek-hop: ana sayfadan keşfedilen iletişim/kariyer alt-sayfalarını da tara (daha fazla contact için).
  // Alt-sayfalardaki linkler TEKRAR takip EDİLMEZ (recursive crawl yok).
  const contactPaths = discoverContactPaths(html, url);
  const pages: Array<{ text: string; pageUrl: string }> = [{ text, pageUrl: url }];
  let pagesFound = 0;
  for (const contactUrl of contactPaths) {
    const { status: cStatus, html: cHtml, finalUrl: cFinalUrl } = await fetchHtml(contactUrl); // best-effort: fetchRaw hata yutar, throw etmez
    if (cStatus === 200 && cHtml) {
      pagesFound++;
      pages.push({ text: htmlToText(cHtml).slice(0, 20_000), pageUrl: cFinalUrl }); // redirect sonrası gerçek URL saklanır
    }
  }
  // Tüm sayfalardan e-posta topla; email'e göre dedupe et — gerçek kaynağın URL'i evidence_url olarak SAKLANIR
  // (ilk bulunduğu sayfa kazanır; ana sayfa listede ilk sırada olduğu için varsayılan olarak ona öncelik verir).
  const emailByAddr = new Map<string, { email: string; generic: boolean; pageUrl: string }>();
  for (const p of pages) {
    for (const e of extractEmails(p.text, c.domain)) {
      if (!emailByAddr.has(e.email)) emailByAddr.set(e.email, { ...e, pageUrl: p.pageUrl });
    }
  }
  // Faz 1b: varsayılan olarak yalnız jenerik kurumsal kutu (KVKK hijyeni); b2b_pro istisnası: TECHNICAL_LOCALS
  // zaten extractEmails()'te elendiği için isim-bazlı adresler de (kişinin kendi yayınladığı sayfada
  // bulunduğu için) güvenle kabul edilir. İstisna İKİ bağımsız sinyalin (segment VE entity_type) aynı anda
  // "bireysel profesyonel" demesini şart koşar — tek sinyale (yalnız segment) güvenmek, bir sınıflandırma
  // hatasını doğrudan yanlış bir consent_basis audit-kaydına dönüştürebilir.
  const isB2bProIndividual = segment === "b2b_pro" && entityType === "birey";
  const emails = [...emailByAddr.values()].filter((e) => e.generic || isB2bProIndividual);
  let contacts = 0;
  for (const e of emails) {
    const ins = await query<{ id: number }>(
      `insert into lead_contacts(company_id, email, is_generic_corporate, consent_basis, email_status, status, evidence_url)
       values ($1,$2,$3,$4,'unknown','new',$5) on conflict (email) do nothing returning id`,
      [companyId, e.email, e.generic, e.generic ? null : "self_published_professional_contact", e.pageUrl],
    );
    const id = ins.rows[0]?.id;
    if (id) {
      contacts++;
      await enqueue({ loop: "leadgen", kind: "leadgen:verify", payload: { contactId: id }, dedupeKey: `verify:${e.email}` });
    }
  }
  await audit({
    loop: "leadgen",
    action: "enrich.done",
    target: c.name,
    detail: { icp, segment, contacts, pagesChecked: contactPaths.length, pagesFound },
  });
  log.info({ company: c.name, icp, contacts }, "enrich tamam");
  return { costUsd: 0 };
};

// ----- leadgen:verify (email-verify API; key yoksa graceful 'unknown') -----
export const leadgenVerify: Handler = async (job) => {
  const contactId = Number((job.payload as { contactId?: number }).contactId);
  const c = (await query<{ email: string; status: string }>(`select email,status from lead_contacts where id=$1`, [contactId])).rows[0];
  if (!c) return { costUsd: 0 };
  // TODO(dış-TODO): EMAIL_VERIFY_API_KEY gelince gerçek doğrulama (MillionVerifier/ZeroBounce).
  // Şimdilik: doğrulanamadı → 'unknown' (deny-by-default kapısı bunu send'e geçirmez).
  const emailStatus = "unknown";
  try {
    assertLeadTransition(c.status, "verified");
  } catch {
    /* zaten ileri durumda */
  }
  await query(`update lead_contacts set email_status=$2, status='verified' where id=$1`, [contactId, emailStatus]);
  await enqueue({ loop: "leadgen", kind: "leadgen:draft", payload: { contactId }, dedupeKey: `draft:${c.email}` });
  return { costUsd: 0 };
};

// ----- leadgen:draft (writer taslak + grounding check → draft_for_review, GÖNDERİM YOK) -----
const DraftSchema = z.object({ subject: z.string().min(3), body: z.string().min(10) });
const GroundSchema = z.object({ grounded: z.boolean(), reason: z.string().optional() });

export const leadgenDraft: Handler = async (job) => {
  const contactId = Number((job.payload as { contactId?: number }).contactId);
  const row = (
    await query<{ email: string; status: string; company: string; segment: string | null; why_now: string | null; evidence_url: string | null }>(
      `select lc.email, lc.status, co.name as company, co.segment, co.signals->>'why_now' as why_now, co.evidence_url
         from lead_contacts lc join lead_companies co on co.id=lc.company_id where lc.id=$1`,
      [contactId],
    )
  ).rows[0];
  if (!row) return { costUsd: 0 };

  const evidence = { company: row.company, segment: row.segment, why_now: row.why_now, source: row.evidence_url };
  const draft = await writerJson({
    loop: "leadgen",
    jobId: job.id,
    schema: DraftSchema,
    system:
      "Reflektif (kariyer-rehberlik/bilan SaaS, TR) için kısa bir B2B outreach e-postası TASLAĞI yaz. Kuralları:\n" +
      "- Yalnız verilen EVIDENCE'a dayan; kurum hakkında UYDURMA bilgi YOK.\n" +
      "- Kişisel, kısa (≤120 kelime), tek net CTA (kısa demo). Spam-tetikleyici abartı yok.\n" +
      "- TR. JSON: {subject, body}.",
    user: `EVIDENCE: ${JSON.stringify(evidence)}`,
  });

  // Anti-halüsinasyon verify-pass: gövde evidence-dışı olgu iddia ediyor mu?
  let grounded = true;
  try {
    const g = await bulkJson({
      loop: "leadgen",
      jobId: job.id,
      schema: GroundSchema,
      system: "E-posta gövdesi, verilen EVIDENCE'ta OLMAYAN bir olgu (rakam, ürün, olay) iddia ediyor mu? JSON {grounded:boolean, reason?}.",
      user: `EVIDENCE: ${JSON.stringify(evidence)}\n\nBODY: ${draft.body}`,
    });
    grounded = g.grounded;
  } catch {
    grounded = true; // check başarısızsa insan-review'a bırak
  }

  try {
    assertLeadTransition(row.status, "drafted");
  } catch {
    /* ileri durumda */
  }
  const gate = await canSend(row.email); // Faz 3 için hesapla, ŞİMDİ göndermez
  await query(
    `insert into outreach_messages(contact_id, channel, step, subject, body, status, evidence_snapshot)
     values ($1,'email',1,$2,$3,'draft_for_review',$4)`,
    [contactId, draft.subject, draft.body, JSON.stringify({ evidence, grounded, sendable: gate.ok, gate_reason: gate.reason })],
  );
  await query(`update lead_contacts set status='drafted' where id=$1`, [contactId]);
  await audit({ loop: "leadgen", action: "draft.created", target: row.email, decision: "gated", detail: { grounded, sendable: gate.ok, gate_reason: gate.reason } });
  log.info({ email: row.email, grounded, sendable: gate.ok }, "taslak oluşturuldu (draft_for_review)");
  return { costUsd: 0 };
};
