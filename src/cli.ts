import { migrate } from "./migrate";
import { tick } from "./tick";
import { runWorkerTurn } from "./core/worker";
import { enqueue, reapExpired } from "./core/queue";
import { pause, resume } from "./core/switches";
import { query, pool } from "./db/pool";
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
        "komutlar: migrate | tick | worker | reaper | status | smoke | pause <loop> <reason> | resume <loop>",
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
