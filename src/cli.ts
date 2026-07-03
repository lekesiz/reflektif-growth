import { migrate } from "./migrate";
import { tick } from "./tick";
import { runWorkerTurn } from "./core/worker";
import { enqueue, reapExpired } from "./core/queue";
import { pause, resume } from "./core/switches";
import { query, pool, withClient } from "./db/pool";
import { extractOrgLinks, discoverContactPaths, normSegment } from "./loops/leadgen";
import { mapResult, type EmailStatus } from "./verify/emailVerify";
import { runJsonWithRepair } from "./llm/repair";
import { audit } from "./core/audit";
import {
  notionConfigured,
  notionUpsertLead,
  mapKategori,
  mapOncelik,
  mapDurum,
  buildNotlar,
  websiteUrl,
  websiteHost,
  type NotionLead,
} from "./notify/notion";
import { z } from "zod";
import { childLogger } from "./core/logger";

const log = childLogger("cli");

async function status(): Promise<void> {
  const sw = await query(`select loop, enabled, paused_reason from agent_switches order by loop`);
  const jobs = await query(`select status, count(*)::int as c from agent_jobs group by status order by status`);
  const cost = await query(
    `select loop, coalesce(sum(usd),0)::text as usd from agent_cost_ledger where at::date=current_date group by loop`,
  );
  const audits = await query(`select at, loop, action, decision from agent_audit order by at desc limit 5`);
  console.log("switches:", sw.rows);
  console.log("jobs:", jobs.rows);
  console.log("cost today:", cost.rows);
  console.log("recent audit:", audits.rows);
}

async function smoke(): Promise<void> {
  const key = `smoke-${Date.now()}`;
  const id = await enqueue({ loop: "test", kind: "test:echo", payload: { hello: "faz0" }, dedupeKey: key });
  log.info({ id }, "enqueued");

  let ran = 0;
  for (let i = 0; i < 10; i++) {
    const r = await runWorkerTurn("test", ["test:echo"]);
    if (r === "ran") ran++;
    if (r === "idle") break;
  }
  const row = await query<{ status: string }>(`select status from agent_jobs where dedupe_key=$1`, [key]);
  const st = row.rows[0]?.status;
  log.info({ id, status: st, ran }, "smoke result");
  if (st !== "done") throw new Error(`SMOKE FAILED: status=${st}`);

  // idempotency: aynı dedupe_key → null
  const dup = await enqueue({ loop: "test", kind: "test:echo", dedupeKey: key });
  log.info({ dup }, dup === null ? "idempotency OK (dedupe engelledi)" : "WARN: dedupe uygulanmadı");

  // kill-switch: pause → turn 'paused' dönmeli
  await pause("test", "smoke-test", "cli");
  const paused = await runWorkerTurn("test", ["test:echo"]);
  await resume("test", "cli");
  log.info({ paused }, paused === "paused" ? "kill-switch OK" : "WARN: kill-switch uygulanmadı");

  if (dup !== null) throw new Error("SMOKE FAILED: idempotency");
  if (paused !== "paused") throw new Error("SMOKE FAILED: kill-switch");

  // leadgen sourcing extractor — deterministik (ağsız) doğrulama.
  const fixture = `<html><body>
    <a href="/dahili">iç</a>
    <a href="https://tr.wikipedia.org/wiki/x">kaynak-içi</a>
    <a href="https://www.facebook.com/foo">sosyal</a>
    <a href="mailto:a@b.com">mail</a>
    <a href="https://www.itu.edu.tr/">&#304;stanbul Teknik &#220;niversitesi</a>
    <a href="https://itu.edu.tr/tekrar">ITÜ tekrar (dedupe)</a>
    <a href="https://www.example.com/">özel şirket (filtre dışı)</a>
  </body></html>`;
  const src = "https://tr.wikipedia.org/wiki/liste";
  const all = extractOrgLinks(fixture, src);
  const eduOnly = extractOrgLinks(fixture, src, "\\.edu\\.tr$");
  log.info({ all: all.map((c) => c.domain), eduOnly: eduOnly.map((c) => c.domain) }, "sourcing extractor");
  if (eduOnly.length !== 1 || eduOnly[0]?.domain !== "itu.edu.tr" || eduOnly[0]?.name !== "İstanbul Teknik Üniversitesi") {
    throw new Error(`SMOKE FAILED: sourcing filter → ${JSON.stringify(eduOnly)}`);
  }
  if (all.some((c) => c.domain.includes("facebook") || c.domain.includes("wikipedia")) || !all.some((c) => c.domain === "example.com")) {
    throw new Error(`SMOKE FAILED: sourcing dedupe/infra → ${JSON.stringify(all)}`);
  }

  // excludeFilter (per-kaynak gürültü elemesi) — domainFilter/infra/iç-link elemesine EK negatif filtre.
  // Kaynağın kendi domaininden FARKLI bir 'gürültü' host'u excludeFilter ile elenmeli, gerçek host kalmalı.
  const excludeFixture = `<html><body>
    <a href="https://spam-ajans.com/">siteyi yapan web-ajansı (gürültü)</a>
    <a href="https://gercekfirma.com/">gerçek üye firma</a>
  </body></html>`;
  const exSrc = "https://portal.dizin.com/liste";
  const excluded = extractOrgLinks(excludeFixture, exSrc, null, "(^|\\.)spam-ajans\\.com$");
  log.info({ excluded: excluded.map((c) => c.domain) }, "exclude filter extractor");
  if (excluded.some((c) => c.domain.endsWith("spam-ajans.com")) || !excluded.some((c) => c.domain === "gercekfirma.com")) {
    throw new Error(`SMOKE FAILED: excludeFilter → ${JSON.stringify(excluded)}`);
  }
  // Bozuk exclude regex → fail-open (yok sayılır; gerçek host yine döner, çökme yok).
  const excludeBroken = extractOrgLinks(excludeFixture, exSrc, null, "([broken");
  if (!excludeBroken.some((c) => c.domain === "gercekfirma.com") || !excludeBroken.some((c) => c.domain === "spam-ajans.com")) {
    throw new Error(`SMOKE FAILED: excludeFilter fail-open → ${JSON.stringify(excludeBroken)}`);
  }

  // leadgen enrich alt-sayfa keşfi — deterministik (ağsız) doğrulama.
  const contactFixture = `<html><body>
    <a href="/iletisim">İletişim</a>
    <a href="/kariyer">Kariyer</a>
    <a href="/hakkimizda">Hakkımızda</a>
    <a href="https://baska-domain.com/contact">dış site</a>
  </body></html>`;
  const contactBase = "https://ornekkurum.com/";
  const contactPaths = discoverContactPaths(contactFixture, contactBase);
  log.info({ contactPaths }, "contact-path extractor");
  if (!contactPaths.includes("https://ornekkurum.com/iletisim") || !contactPaths.includes("https://ornekkurum.com/kariyer")) {
    throw new Error(`SMOKE FAILED: contact-path bulunamadı → ${JSON.stringify(contactPaths)}`);
  }
  if (contactPaths.some((u) => u.includes("hakkimizda") || u.includes("baska-domain.com"))) {
    throw new Error(`SMOKE FAILED: contact-path gürültü içeriyor → ${JSON.stringify(contactPaths)}`);
  }

  // leadgen normSegment — deterministik (ağsız, LLM'siz) doğrulama; b2b_pro eklenirken mevcut
  // edu/ld regresyonlarının bozulmadığından ve 'danışmanlık'ın b2b_pro'ya sızmadığından emin ol.
  const segChecks: Array<[string, string]> = [
    ["Bağımsız kariyer koçu", "b2b_pro"],
    ["Üniversite kariyer merkezi", "b2b_edu"],
    ["Kurumsal İK danışmanlığı firması", "b2b2c_ld"],
    ["Psikolog - bireysel danışmanlık", "b2b_pro"],
    // 'bağımsız'/'koç'/'serbest' kurumsal metinlerle çakıştığında b2b2c_ld kazanmalı (regresyon).
    ["Bağımsız İK Danışmanlığı Firması", "b2b2c_ld"],
    ["Bağımsız Denetim ve Danışmanlık A.Ş.", "b2b2c_ld"],
    ["Koç Holding İnsan Kaynakları Kurumu", "b2b2c_ld"],
    ["Serbest Bölge Kurumsal Danışmanlık", "b2b2c_ld"],
    // LLM'in literal enum değerini birebir döndürdüğü durum (regresyon: önceden sessizce b2c'ye düşüyordu).
    ["b2b_pro", "b2b_pro"],
  ];
  for (const [input, expected] of segChecks) {
    const got = normSegment(input);
    if (got !== expected) {
      throw new Error(`SMOKE FAILED: normSegment(${JSON.stringify(input)}) → ${got}, beklenen ${expected}`);
    }
  }

  // ollamaJson retry/repair sürücüsü — ağsız (fake generate) deterministik doğrulama.
  // Canlıda çözülen bug: qwen3 bazen eksik-alan / bozuk JSON üretiyor → zod.parse patlıyor → job 'dead'.
  // Not: gerçek Ollama entegrasyonu (fetch + timeout) canlı Verify fazında test edilecek; burada yalnız
  // saf döngü mantığı (parse-fail + zod-fail retry, repair reprompt, tükeninve throw, maxAttempts=1 = no-retry).
  const RepairSchema = z.object({ subject: z.string().min(3), body: z.string().min(10) });

  // (A) 1. deneme: JSON-DIŞI çöp (parse hatası) → 2. deneme: eksik 'body' (zod hatası) → 3. deneme: geçerli.
  let calls = 0;
  const suffixes: string[] = [];
  const repaired = await runJsonWithRepair({
    schema: RepairSchema,
    maxAttempts: 3,
    generate: async ({ repairSuffix }) => {
      calls++;
      suffixes.push(repairSuffix);
      if (calls === 1) return "üzgünüm, işte cevabın: (geçersiz)";
      if (calls === 2) return `{"subject":"Merhaba Reflektif"}`;
      return `<think>gövdeyi de ekleyeyim</think>{"subject":"Merhaba Reflektif","body":"Bu yeterince uzun bir taslak gövdesidir."}`;
    },
  });
  if (calls !== 3 || repaired.body.length < 10) {
    throw new Error(`SMOKE FAILED: repair sürücüsü → calls=${calls}, out=${JSON.stringify(repaired)}`);
  }
  // İlk deneme repair'siz (""), sonraki denemeler eksik alan adını + [DÜZELTME] talimatını içermeli.
  if (suffixes[0] !== "" || !suffixes[2]?.includes("body") || !suffixes[2]?.includes("[DÜZELTME]")) {
    throw new Error(`SMOKE FAILED: repair reprompt yapısı → ${JSON.stringify(suffixes)}`);
  }

  // (B) tüm denemeler başarısız → THROW (sessiz boş/uydurma değer DÖNMEZ).
  let threw = false;
  try {
    await runJsonWithRepair({ schema: RepairSchema, maxAttempts: 2, generate: async () => `{}` });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("SMOKE FAILED: tükenen retry throw etmedi");

  // (C) maxAttempts=1 → retry YOK (eski davranış): başarısız generate tam 1 kez çağrılıp throw eder.
  let onceCalls = 0;
  let threwOnce = false;
  try {
    await runJsonWithRepair({
      schema: RepairSchema,
      maxAttempts: 1,
      generate: async () => {
        onceCalls++;
        return `{}`;
      },
    });
  } catch {
    threwOnce = true;
  }
  if (onceCalls !== 1 || !threwOnce) {
    throw new Error(`SMOKE FAILED: maxAttempts=1 no-retry → calls=${onceCalls}, threw=${threwOnce}`);
  }

  // (D) Claude yolu (ağsız güvence): Anthropic'te format:"json" YOK → model bazen ```json ... ``` ile sarar.
  // Paylaşılan repair.ts/parseJson ilk {...} bloğunu yakalayıp TEK denemede (repair'siz) kurtarmalı.
  let fenceCalls = 0;
  const fenced = await runJsonWithRepair({
    schema: RepairSchema,
    maxAttempts: 2,
    generate: async () => {
      fenceCalls++;
      return '```json\n{"subject":"Merhaba Reflektif","body":"Bu yeterince uzun bir taslak gövdesidir."}\n```';
    },
  });
  if (fenceCalls !== 1 || fenced.subject !== "Merhaba Reflektif" || fenced.body.length < 10) {
    throw new Error(`SMOKE FAILED: markdown-fenced JSON kurtarılamadı → calls=${fenceCalls}, out=${JSON.stringify(fenced)}`);
  }

  // notion CRM eşleme (saf, ağsız) — select'e OLMAYAN değer üretmemeli; öncelik/durum eşiği + notlar formatı.
  // Canlı Notion çağrısı burada YOK (Verify fazında). Yalnız deterministik eşleme kapısı doğrulanır.
  if (mapKategori("itu.edu.tr", "b2b2c_ld") !== "Üniversite") throw new Error("SMOKE FAILED: notion kategori .edu.tr → Üniversite (domain segment'ten önce)");
  if (mapKategori("ozelokul.k12.tr", null) !== "Okul") throw new Error("SMOKE FAILED: notion kategori .k12.tr → Okul");
  if (mapKategori("kariyerkocu.com", "b2b_pro") !== "Koçluk") throw new Error("SMOKE FAILED: notion kategori b2b_pro → Koçluk");
  if (mapKategori("ikyazilim.com", "b2b2c_ld") !== "İK Yazılım") throw new Error("SMOKE FAILED: notion kategori b2b2c_ld → İK Yazılım");
  if (mapKategori("egitim.com", "b2b_edu") !== "Üniversite") throw new Error("SMOKE FAILED: notion kategori b2b_edu(diğer) → Üniversite");
  if (mapKategori("genel.com", "b2c") !== null) throw new Error("SMOKE FAILED: notion kategori b2c → BOŞ olmalı (yanlış option üretme)");
  if (mapKategori("bilinmeyen.com", null) !== null) throw new Error("SMOKE FAILED: notion kategori bilinmeyen → BOŞ olmalı");
  if (
    mapOncelik(90) !== "P0" || mapOncelik(85) !== "P0" || mapOncelik(84) !== "P1" || mapOncelik(75) !== "P1" ||
    mapOncelik(74) !== "P2" || mapOncelik(60) !== "P2" || mapOncelik(59) !== "P3" || mapOncelik(0) !== "P3"
  ) {
    throw new Error("SMOKE FAILED: notion öncelik eşiği (85→P0, 75→P1, 60→P2, <60→P3)");
  }
  if (mapDurum(true) !== "Hazırlanıyor" || mapDurum(false) !== "Araştırılacak") {
    throw new Error("SMOKE FAILED: notion durum (draft→Hazırlanıyor / yoksa→Araştırılacak)");
  }
  const notlar = buildNotlar({
    companyName: "X", domain: "x.com", segment: null, icpScore: 70,
    whyNow: "neden şimdi", evidenceUrl: "https://x.com/kaynak", email: null, draftSubject: "Kısa demo?",
  });
  if (notlar !== "neden şimdi\nKaynak: https://x.com/kaynak\nTaslak: Kısa demo?") {
    throw new Error(`SMOKE FAILED: notion notlar formatı → ${JSON.stringify(notlar)}`);
  }
  if (websiteUrl("www.itu.edu.tr/") !== "https://itu.edu.tr") {
    throw new Error(`SMOKE FAILED: notion websiteUrl normalize → ${websiteUrl("www.itu.edu.tr/")}`);
  }
  // dedup kanonikleştirme: www/http/trailing-slash/path/case varyantları AYNI host'a inmeli (duplicate önleme)
  for (const v of [
    "kocholding.com.tr",
    "https://www.kocholding.com.tr/",
    "http://kocholding.com.tr",
    "https://KocHolding.com.tr/iletisim?x=1",
    "www.KOCHOLDING.com.tr",
  ]) {
    if (websiteHost(v) !== "kocholding.com.tr") {
      throw new Error(`SMOKE FAILED: notion websiteHost dedup normalize → ${v} → ${websiteHost(v)}`);
    }
  }

  // email-verify EŞLEME (saf fonksiyon, AĞSIZ) — MillionVerifier result → lead_contacts.email_status haritası.
  // Canlı MillionVerifier çağrısı burada YOK (kredi harcamaz); yalnız deterministik eşleme kapısı doğrulanır.
  // catch_all→risky KASITLI: var olduğu kanıtlanamayan kutu 'valid' OLMAZ (deny-by-default'ı korur).
  const verifyMap: Array<[string, EmailStatus]> = [
    ["ok", "valid"],
    ["catch_all", "risky"],
    ["invalid", "invalid"],
    ["disposable", "invalid"],
    ["unknown", "unknown"],
    ["error", "unknown"], // hata/tanınmayan değer → 'unknown'
    ["", "unknown"], // boş/eksik result → 'unknown'
  ];
  for (const [input, expected] of verifyMap) {
    const got = mapResult(input);
    if (got !== expected) {
      throw new Error(`SMOKE FAILED: mapResult(${JSON.stringify(input)}) → ${got}, beklenen ${expected}`);
    }
  }

  console.log("SMOKE_PASS");
}

// ----- notion-sync: enrich edilmiş bizim-kaynaklı lead'leri 'Reflektif CRM'e yaz (İDEMPOTENT + TAHRİBATSIZ) -----
// Kapsam: source LIKE 'dizin:%' AND icp_score IS NOT NULL AND notion_page_id IS NULL (henüz sync edilmemiş).
// --dry-run: hiçbir şey yazmaz, ne yapılacağını (kaç lead + örnek eşleme) gösterir. --limit N: en fazla N lead.
// GÜVENLİK: bu BİZİM CRM'imize yazma — lead'lere gönderim DEĞİL. Mevcut manuel sayfalar ASLA ezilmez.
async function notionSync(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  let limit = 50; // rate-limit dostu varsayılan batch; --limit ile artırılabilir
  const li = args.findIndex((a) => a === "--limit" || a.startsWith("--limit="));
  if (li >= 0) {
    const flag = args[li] ?? "";
    const raw = flag.includes("=") ? flag.split("=")[1] : args[li + 1];
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
  }

  if (!dryRun && !notionConfigured()) {
    console.log("notion-sync: NOTION_TOKEN yok (kasadan çek: pnpm secrets:pull). Token'sız önizleme için --dry-run kullan.");
    return;
  }

  const WHERE = `c.source like 'dizin:%' and c.icp_score is not null and c.domain is not null and c.notion_page_id is null`;
  type LeadRow = {
    id: number;
    name: string;
    domain: string;
    segment: string | null;
    icp_score: number | null;
    why_now: string | null;
    evidence_url: string | null;
    email: string | null;
    draft_subject: string | null;
  };

  const fetchTotal = async (): Promise<number> =>
    (await query<{ c: number }>(`select count(*)::int as c from lead_companies c where ${WHERE}`)).rows[0]?.c ?? 0;

  const fetchRows = async (): Promise<LeadRow[]> =>
    (
      await query<LeadRow>(
        `select c.id, c.name, c.domain, c.segment, c.icp_score,
                c.signals->>'why_now' as why_now, c.evidence_url,
                (select lc.email from lead_contacts lc
                   where lc.company_id = c.id and lc.is_generic_corporate = true and lc.email is not null
                   order by lc.id limit 1) as email,
                (select om.subject from outreach_messages om
                   join lead_contacts lc2 on lc2.id = om.contact_id
                   where lc2.company_id = c.id and om.status = 'draft_for_review'
                   order by om.id limit 1) as draft_subject
           from lead_companies c
          where ${WHERE}
          order by c.icp_score desc, c.id
          limit $1`,
        [limit],
      )
    ).rows;

  const toLead = (r: LeadRow): NotionLead => ({
    companyName: r.name,
    domain: r.domain,
    segment: r.segment,
    icpScore: r.icp_score,
    whyNow: r.why_now,
    evidenceUrl: r.evidence_url,
    email: r.email,
    draftSubject: r.draft_subject,
  });

  if (dryRun) {
    const total = await fetchTotal();
    const rows = await fetchRows();
    const sample = rows.slice(0, 10).map((r) => ({
      kurum: r.name?.slice(0, 40),
      website: websiteUrl(r.domain),
      kategori: mapKategori(r.domain, r.segment) ?? "(boş)",
      öncelik: mapOncelik(r.icp_score),
      durum: mapDurum(Boolean(r.draft_subject)),
      email: r.email ?? "(boş)",
    }));
    log.info({ total, willProcess: rows.length, limit }, "notion-sync DRY-RUN — hiçbir şey yazılmadı");
    console.log(`notion-sync DRY-RUN — eşleşen: ${total}, işlenecek (limit ${limit}): ${rows.length}`);
    if (sample.length) console.table(sample);
    return;
  }

  // EŞ-ZAMANLILIK KORUMASI: notionUpsertLead check-then-create'tir (atomik değil). İki çakışan
  // `notion:sync` çalışması aynı satırları (notion_page_id IS NULL) görüp aynı anda create ederse
  // duplicate üretir. Session-level advisory lock ile çalışmaları serileştir; kilidi alamayan ATLAR.
  // Kilit, adanmış tek bir bağlantıda tutulur ve finally'de açıkça bırakılır (havuza dönmeden önce).
  const LOCK_KEY = 0x4e53594e; // "NSYN" — notion-sync tekil-çalışma kilidi (keyfi sabit)
  await withClient(async (c) => {
    const got = (await c.query<{ locked: boolean }>(`select pg_try_advisory_lock($1) as locked`, [LOCK_KEY])).rows[0]?.locked;
    if (!got) {
      log.warn("notion-sync: başka bir çalışma advisory lock tutuyor — ATLANDI (duplicate önlendi)");
      console.log("notion-sync: başka bir çalışma sürüyor (kilit) — atlandı");
      return;
    }
    try {
      const total = await fetchTotal();
      const rows = await fetchRows();
      let created = 0;
      let skipped = 0;
      let failed = 0;
      for (const r of rows) {
        try {
          const res = await notionUpsertLead(toLead(r));
          // Oluşturulan VEYA bulunan mevcut sayfayı işaretle → tekrar-sync'te duplicate ÜRETME.
          await query(`update lead_companies set notion_page_id=$2 where id=$1`, [r.id, res.pageId]);
          if (res.created) {
            created++;
            await audit({
              loop: "leadgen",
              action: "notion.synced",
              target: r.domain,
              decision: "auto",
              riskTier: "green",
              detail: {
                pageId: res.pageId,
                kategori: mapKategori(r.domain, r.segment),
                öncelik: mapOncelik(r.icp_score),
                durum: mapDurum(Boolean(r.draft_subject)),
              },
            });
          } else {
            skipped++;
            await audit({
              loop: "leadgen",
              action: "notion.skipped_existing",
              target: r.domain,
              decision: "blocked",
              riskTier: "green",
              detail: { pageId: res.pageId, reason: "mevcut sayfa (manuel olabilir) — DOKUNULMADI" },
            });
          }
        } catch (e) {
          failed++;
          const err = e instanceof Error ? e.message : String(e);
          await audit({ loop: "leadgen", action: "notion.sync_failed", target: r.domain, decision: "blocked", riskTier: "green", detail: { err } });
          log.warn({ domain: r.domain, err }, "notion-sync lead hatası (atlandı)");
        }
      }
      log.info({ created, skipped, failed, of: rows.length, matching: total }, "notion-sync tamam");
      console.log(`notion-sync: created=${created} skipped(existing)=${skipped} failed=${failed} (of ${rows.length}, matching ${total})`);
    } finally {
      await c.query(`select pg_advisory_unlock($1)`, [LOCK_KEY]);
    }
  });
}

// drafts — gönderilmesi PLANLANAN içerikleri (taslak e-postalar) incele. SALT-OKUNUR; hiçbir şey göndermez.
//   pnpm cli drafts [--limit N] [--segment b2b_edu|b2b2c_ld|b2b_pro|b2c] [--full]
async function draftsReview(args: string[]): Promise<void> {
  const limIdx = args.indexOf("--limit");
  const limit = limIdx >= 0 ? Math.max(1, Number(args[limIdx + 1]) || 20) : 20;
  const segIdx = args.indexOf("--segment");
  const segment = segIdx >= 0 ? args[segIdx + 1] : null;
  const full = args.includes("--full");

  // Özet: kaç taslak, segment + gönderilebilirlik dağılımı (gate yalnız HESAP; gönderim yok).
  const sum = await query<{ segment: string | null; sendable: string; c: number }>(
    `select co.segment,
            coalesce(om.evidence_snapshot->>'sendable','?') as sendable,
            count(*)::int as c
       from outreach_messages om
       join lead_contacts lc on lc.id=om.contact_id
       join lead_companies co on co.id=lc.company_id
      group by 1,2 order by 3 desc`,
  );
  const total = sum.rows.reduce((a, r) => a + r.c, 0);
  const sendableYes = sum.rows.filter((r) => r.sendable === "true").reduce((a, r) => a + r.c, 0);
  console.log(`\n=== TASLAKLAR: ${total} · sendable=${sendableYes} (gönderim KAPALI — deny-by-default) ===`);
  console.log("segment × sendable:", sum.rows.map((r) => `${r.segment ?? "?"}/${r.sendable}:${r.c}`).join("  "));

  const rows = await query<{
    company: string; segment: string | null; icp: number | null; email: string; email_status: string;
    subject: string; body: string; sendable: string | null; gate_reason: string | null; grounded: string | null;
  }>(
    `select co.name as company, co.segment, co.icp_score as icp, lc.email, lc.email_status,
            om.subject, om.body,
            om.evidence_snapshot->>'sendable' as sendable,
            om.evidence_snapshot->>'gate_reason' as gate_reason,
            om.evidence_snapshot->>'grounded' as grounded
       from outreach_messages om
       join lead_contacts lc on lc.id=om.contact_id
       join lead_companies co on co.id=lc.company_id
      where ($1::text is null or co.segment=$1)
      order by co.icp_score desc nulls last, om.id
      limit $2`,
    [segment, limit],
  );
  console.log(`\n(gösterilen: ${rows.rows.length}${segment ? ` · segment=${segment}` : ""}${full ? "" : " · özet gövde; tam metin için --full"})\n`);
  for (const r of rows.rows) {
    const gate = r.sendable === "true" ? "sendable" : `GÖNDERİLEMEZ (${r.gate_reason ?? "?"})`;
    console.log(`── ${r.company}  [${r.segment ?? "?"} · ICP ${r.icp ?? "?"} · ${r.email} · ${r.email_status} · ${gate} · grounded=${r.grounded}]`);
    console.log(`   Konu: ${r.subject}`);
    const body = full ? r.body : r.body.replace(/\s+/g, " ").slice(0, 200) + (r.body.length > 200 ? "…" : "");
    console.log(`   ${body.split("\n").join("\n   ")}\n`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "migrate":
      await migrate();
      break;
    case "tick":
      await tick();
      break;
    case "worker": {
      let ran = 0;
      for (let i = 0; i < 20; i++) {
        const r = await runWorkerTurn("test", ["test:echo"]);
        if (r === "idle") break;
        if (r === "ran") ran++;
      }
      log.info({ ran }, "worker bitti");
      break;
    }
    case "add-lead": {
      // add-lead <domain> [name]  → kurum ekle + enrich enqueue (manuel curation girişi)
      const domain = args[0];
      if (!domain) {
        console.log("kullanım: add-lead <domain> [name]");
        break;
      }
      const name = args.slice(1).join(" ") || domain;
      const r = await query<{ id: number }>(
        `insert into lead_companies(name, domain, source) values ($1,$2,'manual')
         on conflict (domain) do update set name=excluded.name returning id`,
        [name, domain],
      );
      const id = r.rows[0]?.id;
      if (id) {
        await enqueue({ loop: "leadgen", kind: "leadgen:enrich", payload: { companyId: id }, dedupeKey: `enrich:${domain}` });
        log.info({ id, domain }, "lead eklendi + enrich kuyruğa");
      }
      break;
    }
    case "add-source": {
      // add-source <url> [domainFilter] [name...]  → dizin ekle (tick otonom tarar)
      const url = args[0];
      if (!url) {
        console.log("kullanım: add-source <url> [domainFilter-regex] [name...]");
        break;
      }
      const domainFilter = args[1] && args[1] !== "-" ? args[1] : null;
      let name = args.slice(2).join(" ");
      if (!name) {
        try {
          name = new URL(url).hostname.replace(/^www\./, "");
        } catch {
          name = url;
        }
      }
      const r = await query<{ id: number }>(
        `insert into lead_sources(name, url, domain_filter)
           values ($1,$2,$3)
         on conflict (url) do update set name=excluded.name, domain_filter=excluded.domain_filter, active=true
         returning id`,
        [name, url, domainFilter],
      );
      log.info({ id: r.rows[0]?.id, url, domainFilter }, "dizin eklendi (aktif)");
      break;
    }
    case "list-sources": {
      const r = await query(
        `select id, name, url, domain_filter, active,
                (select count(*) from lead_companies lc where lc.source='dizin:'||ls.name)::int as leads
           from lead_sources ls order by id`,
      );
      console.log("lead_sources:", r.rows);
      break;
    }
    case "reaper":
      log.info({ reaped: await reapExpired() }, "reaper");
      break;
    case "pause":
      await pause(args[0] ?? "GLOBAL", args[1] ?? "cli-pause", "cli");
      log.info({ loop: args[0] ?? "GLOBAL" }, "paused");
      break;
    case "resume":
      await resume(args[0] ?? "GLOBAL", "cli");
      log.info({ loop: args[0] ?? "GLOBAL" }, "resumed");
      break;
    case "status":
      await status();
      break;
    case "smoke":
      await smoke();
      break;
    case "notion-sync":
      await notionSync(args);
      break;
    case "drafts":
      await draftsReview(args);
      break;
    default:
      console.log(
        "komutlar: migrate | tick | worker | reaper | status | smoke | drafts [--limit N] [--segment X] [--full] | add-lead <domain> [ad] | add-source <url> [filter] [ad] | list-sources | notion-sync [--dry-run] [--limit N] | pause <loop> <reason> | resume <loop>",
      );
  }
}

main()
  .catch((e) => {
    log.error({ err: e instanceof Error ? e.message : String(e) }, "cli hata");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
