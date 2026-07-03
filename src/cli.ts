import { migrate } from "./migrate";
import { tick } from "./tick";
import { runWorkerTurn } from "./core/worker";
import { enqueue, reapExpired } from "./core/queue";
import { pause, resume } from "./core/switches";
import { query, pool } from "./db/pool";
import { extractOrgLinks, discoverContactPaths, normSegment } from "./loops/leadgen";
import { runJsonWithRepair } from "./llm/repair";
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

  console.log("SMOKE_PASS");
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
    default:
      console.log(
        "komutlar: migrate | tick | worker | reaper | status | smoke | add-lead <domain> [ad] | add-source <url> [filter] [ad] | list-sources | pause <loop> <reason> | resume <loop>",
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
