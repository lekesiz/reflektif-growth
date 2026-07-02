import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { withClient } from "./db/pool";
import { childLogger } from "./core/logger";

const log = childLogger("migrate");

export async function migrate(): Promise<void> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await withClient(async (c) => {
    await c.query(
      `create table if not exists schema_migrations(version text primary key, applied_at timestamptz not null default now())`,
    );
    for (const f of files) {
      const applied = await c.query(`select 1 from schema_migrations where version=$1`, [f]);
      if ((applied.rowCount ?? 0) > 0) {
        log.info({ f }, "zaten uygulanmış");
        continue;
      }
      const sql = readFileSync(join(dir, f), "utf8");
      try {
        await c.query("begin");
        await c.query(sql);
        await c.query(`insert into schema_migrations(version) values ($1)`, [f]);
        await c.query("commit");
        log.info({ f }, "uygulandı");
      } catch (e) {
        await c.query("rollback");
        log.error({ f, err: e instanceof Error ? e.message : String(e) }, "migration hatası");
        throw e;
      }
    }
  });
}
