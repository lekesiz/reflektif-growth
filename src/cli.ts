import { migrate } from "./migrate";
import { tick } from "./tick";
import { runWorkerTurn } from "./core/worker";
import { enqueue, reapExpired } from "./core/queue";
import { pause, resume } from "./core/switches";
import { query, pool } from "./db/pool";
import { extractOrgLinks, discoverContactPaths } from "./loops/leadgen";
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
