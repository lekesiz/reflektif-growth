import { createHash } from "node:crypto";
import { query } from "../db/pool";

export function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// content_hash değişmediyse tekrar işleme yok (maliyet + gürültü + tekrar-aksiyon engeli).
// Dönüş: değiştiyse true (ve yeni hash kaydedilir), aynıysa false.
export async function markIfChanged(key: string, content: string): Promise<boolean> {
  const h = hashContent(content);
  const prev = await query<{ content_hash: string }>(
    `select content_hash from seen_registry where key=$1`,
    [key],
  );
  if (prev.rows[0]?.content_hash === h) return false;
  await query(
    `insert into seen_registry(key, content_hash, seen_at) values ($1,$2,now())
     on conflict (key) do update set content_hash=excluded.content_hash, seen_at=now()`,
    [key, h],
  );
  return true;
}
