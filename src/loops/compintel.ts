import { z } from "zod";
import type { Handler } from "../core/handler";
import { query } from "../db/pool";
import { env } from "../config/env";
import { audit } from "../core/audit";
import { enqueue } from "../core/queue";
import { markIfChanged, hashContent } from "../core/seen";
import { bulkJson, writerJson } from "../llm/index";
import { notify } from "../notify/telegram";
import { childLogger } from "../core/logger";

const log = childLogger("compintel");

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "reflektif-growth-bot/0.1 (+https://reflektif.info)" },
      signal: AbortSignal.timeout(env.FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    const body = await res.text();
    return { status: res.status, text: htmlToText(body).slice(0, 20_000) };
  } catch {
    return { status: 0, text: "" };
  }
}

interface CompetitorRow {
  id: number;
  name: string;
  homepage: string | null;
  pricing_url: string | null;
  changelog_url: string | null;
}

// compintel:snapshot — rakip sayfalarını çek, değiştiyse snapshot sakla + gap işi enqueue et.
export const compintelSnapshot: Handler = async (job) => {
  const competitorId = Number((job.payload as { competitorId?: number }).competitorId);
  const c = (await query<CompetitorRow>(`select id,name,homepage,pricing_url,changelog_url from competitors where id=$1 and active=true`, [competitorId])).rows[0];
  if (!c) return { costUsd: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const targets: Array<[string, string | null]> = [
    ["pricing", c.pricing_url],
    ["changelog", c.changelog_url],
    ["homepage", c.homepage],
  ];
  for (const [kind, url] of targets) {
    if (!url) continue;
    const { status, text } = await fetchText(url);
    if (status !== 200 || !text) {
      await audit({ loop: "compintel", action: "snapshot.fetch_failed", target: c.name, detail: { kind, url, status } });
      continue;
    }
    const changed = await markIfChanged(`competitor:${competitorId}:${kind}`, text);
    if (!changed) continue; // değişmediyse saklamaya + LLM'e gerek yok
    await query(
      `insert into competitor_snapshots(competitor_id,kind,content_hash,raw) values ($1,$2,$3,$4)`,
      [competitorId, kind, hashContent(text), JSON.stringify({ url, status, excerpt: text.slice(0, 4000) })],
    );
    await enqueue({
      loop: "compintel",
      kind: "compintel:gap",
      payload: { competitorId, kind },
      dedupeKey: `gap:${competitorId}:${kind}:${today}`,
    });
    log.info({ competitor: c.name, kind }, "snapshot değişti → gap kuyruğa");
  }
  return { costUsd: 0 };
};

// Lenient şema: LLM'in kategori/confidence biçim serbestliğini tolere et,
// sonra KOD deterministik olarak normalize+clamp eder (LLM önerir, kod karar verir).
const GapSchema = z.object({
  findings: z.array(
    z.object({
      category: z.string(),
      summary: z.string().min(3),
      confidence: z.coerce.number(),
    }),
  ),
});

const CATS = ["we_lack", "we_lead", "pricing_move", "new_release", "positioning"] as const;
type Cat = (typeof CATS)[number];
function normCategory(c: string): Cat {
  const s = c.toLowerCase();
  if (s.includes("pric") || s.includes("fiyat")) return "pricing_move";
  if (s.includes("feature") || s.includes("release") || s.includes("özellik") || s.includes("yeni") || s.includes("new")) return "new_release";
  if (s.includes("lack") || s.includes("eksik") || s.includes("gap")) return "we_lack";
  if (s.includes("lead") || s.includes("önde") || s.includes("ahead")) return "we_lead";
  return "positioning";
}
const clamp01 = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

interface SnapRow {
  raw: { url: string; excerpt: string; status: number };
}

// compintel:gap — son iki snapshot'ı diff'le, LLM ile anlamlı değişiklikleri çıkar (evidence_url KOD tarafından eklenir).
export const compintelGap: Handler = async (job) => {
  const p = job.payload as { competitorId?: number; kind?: string };
  const competitorId = Number(p.competitorId);
  const kind = String(p.kind);
  const snaps = (
    await query<SnapRow>(
      `select raw from competitor_snapshots where competitor_id=$1 and kind=$2 order by captured_at desc limit 2`,
      [competitorId, kind],
    )
  ).rows;
  if (snaps.length < 2) {
    await audit({ loop: "compintel", action: "gap.baseline", target: `${competitorId}:${kind}` });
    return { costUsd: 0 };
  }
  const cName = (await query<{ name: string }>(`select name from competitors where id=$1`, [competitorId])).rows[0]?.name ?? String(competitorId);
  const newer = snaps[0]!.raw;
  const older = snaps[1]!.raw;
  const result = await bulkJson({
    loop: "compintel",
    jobId: job.id,
    schema: GapSchema,
    system:
      "Sen Reflektif (kariyer-rehberlik/bilan SaaS) için rekabet analistisin. Bir rakibin ESKİ ve YENİ sayfa içeriğini karşılaştırıp Reflektif açısından anlamlı GERÇEK değişiklikleri çıkarırsın. Sadece YENİ içerikte kanıtı olan değişiklikleri bildir; uydurma; değişiklik yoksa boş dizi dön.\n" +
      "ÇIKTI KURALLARI (kesin):\n" +
      "- JSON: {\"findings\":[{\"category\":string,\"summary\":string,\"confidence\":number}]}\n" +
      "- category MUTLAKA şu İngilizce değerlerden biri (aynen): pricing_move, new_release, we_lack, we_lead, positioning\n" +
      "- confidence 0.0 ile 1.0 arasında bir SAYI (tırnaksız, ör. 0.8)\n" +
      "- summary Türkçe, 1-2 cümle.",
    user: `RAKİP: ${cName}\nSAYFA TİPİ: ${kind}\nURL: ${newer.url}\n\n--- ESKİ ---\n${older.excerpt}\n\n--- YENİ ---\n${newer.excerpt}`,
  });
  let inserted = 0;
  for (const f of result.findings) {
    const conf = clamp01(f.confidence);
    if (conf < env.GAP_MIN_CONFIDENCE) continue;
    await query(
      `insert into gap_findings(competitor_id,category,summary,evidence_url,confidence,status) values ($1,$2,$3,$4,$5,'proposed')`,
      [competitorId, normCategory(f.category), f.summary, newer.url, conf], // evidence_url = deterministik sayfa URL'si
    );
    inserted++;
  }
  await audit({ loop: "compintel", action: "gap.analyzed", target: cName, detail: { kind, found: result.findings.length, inserted } });
  return { costUsd: 0 };
};

const DigestSchema = z.object({ headline: z.string(), bullets: z.array(z.string()) });

// compintel:digest — son 7 günün gap_findings'ini TR özetle → Telegram (yoksa log).
export const compintelDigest: Handler = async (job) => {
  const rows = (
    await query<{ name: string | null; category: string; summary: string; evidence_url: string; confidence: string }>(
      `select c.name, gf.category, gf.summary, gf.evidence_url, gf.confidence::text
         from gap_findings gf left join competitors c on c.id=gf.competitor_id
        where gf.status='proposed' and gf.created_at > now() - interval '7 days'
        order by gf.confidence desc limit 40`,
    )
  ).rows;
  if (rows.length === 0) {
    await notify("📊 Reflektif Rakip Radar: son 7 günde yeni bulgu yok.");
    await audit({ loop: "compintel", action: "digest.empty" });
    return { costUsd: 0 };
  }
  const out = await writerJson({
    loop: "compintel",
    jobId: job.id,
    schema: DigestSchema,
    system:
      "Sen Reflektif'in rekabet-istihbarat editörüsün. Verilen rakip-değişiklik bulgularından kısa, aksiyona dönük TR bir haftalık özet üret. Yalnız verilen bulgulara dayan; ekleme yapma. Çıktı JSON: {headline, bullets[]}.",
    user: JSON.stringify(rows),
  });
  const text =
    `📊 <b>Reflektif Rakip Radar</b>\n${out.headline}\n\n` +
    out.bullets.map((b) => `• ${b}`).join("\n") +
    `\n\n(${rows.length} bulgu — detay Notion/CRM)`;
  await notify(text);
  await audit({ loop: "compintel", action: "digest.sent", detail: { findings: rows.length } });
  return { costUsd: 0 };
};
