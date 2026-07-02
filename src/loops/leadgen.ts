import { z } from "zod";
import type { Handler } from "../core/handler";
import { query } from "../db/pool";
import { env } from "../config/env";
import { audit } from "../core/audit";
import { enqueue } from "../core/queue";
import { assertLeadTransition } from "../core/stateMachine";
import { bulkJson, writerJson } from "../llm/index";
import { childLogger } from "../core/logger";

const log = childLogger("leadgen");

// ----- yardımcılar -----
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
    return { status: res.status, text: htmlToText(await res.text()).slice(0, 20_000) };
  } catch {
    return { status: 0, text: "" };
  }
}

const GENERIC_LOCALS = ["info", "bilgi", "iletisim", "ik", "kariyer", "insankaynaklari", "destek", "contact", "hello", "admin", "kayit", "ogrenci"];
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
    out.push({ email, generic: GENERIC_LOCALS.some((g) => local === g || local.startsWith(g)) });
  }
  return out;
}

// Deny-by-default gönderim kapısı (Faz 3 send'in kullanacağı; Faz 1b'de sadece HESAPLANIR).
export async function canSend(email: string): Promise<{ ok: boolean; reason?: string }> {
  if ((await query(`select 1 from suppression_list where email=$1`, [email])).rowCount) return { ok: false, reason: "suppressed" };
  const row = (await query<{ email_status: string; lawful: boolean }>(`select email_status, lawful from lead_contacts where email=$1`, [email])).rows[0];
  if (!row) return { ok: false, reason: "unknown-contact" };
  if (row.email_status !== "valid") return { ok: false, reason: `email_status=${row.email_status}` };
  return { ok: true };
}

// ----- leadgen:enrich -----
// Esnek: sparse sitede model bazı alanları boş bırakabilir → default'la (kod normalize eder).
const EnrichSchema = z.object({
  segment: z.string().default("b2c"),
  entity_type: z.string().default("bilinmiyor"),
  icp_score: z.coerce.number().default(0),
  why_now: z.string().default(""),
});
function normSegment(s: string): "b2b_edu" | "b2b2c_ld" | "b2c" {
  const t = s.toLowerCase();
  if (t.includes("edu") || t.includes("okul") || t.includes("üniv") || t.includes("univ") || t.includes("school")) return "b2b_edu";
  if (t.includes("ld") || t.includes("l&d") || t.includes("ik") || t.includes("hr") || t.includes("kurum")) return "b2b2c_ld";
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
  const c = (await query<{ id: number; name: string; domain: string | null }>(`select id,name,domain from lead_companies where id=$1`, [companyId])).rows[0];
  if (!c || !c.domain) return { costUsd: 0 };
  const url = c.domain.startsWith("http") ? c.domain : `https://${c.domain}`;
  const { status, text } = await fetchText(url);
  if (status !== 200 || !text) {
    await audit({ loop: "leadgen", action: "enrich.fetch_failed", target: c.name, detail: { url, status } });
    return { costUsd: 0 };
  }
  const cls = await bulkJson({
    loop: "leadgen",
    jobId: job.id,
    schema: EnrichSchema,
    system:
      "Sen Reflektif (kariyer-rehberlik/bilan SaaS) için lead nitelendiricisin. Verilen kurumun public site metninden sınıflandır. Uydurma; yalnız metne dayan.\n" +
      "JSON: {segment, entity_type, icp_score, why_now}. segment ∈ {b2b_edu, b2b2c_ld, b2c}. entity_type ∈ {tacir, kamu, birey, bilinmiyor}. icp_score 0-100 SAYI (Reflektif'e uygunluk). why_now = neden şimdi iyi hedef (TR, kısa).",
    user: `KURUM: ${c.name}\nURL: ${url}\n--- İÇERİK ---\n${text.slice(0, 6000)}`,
  });
  const icp = Math.max(0, Math.min(100, Math.round(cls.icp_score)));
  await query(`update lead_companies set segment=$2, entity_type=$3, icp_score=$4, signals=$5, evidence_url=$6 where id=$1`, [
    companyId,
    normSegment(cls.segment),
    normEntity(cls.entity_type),
    icp,
    JSON.stringify({ why_now: cls.why_now }),
    url,
  ]);
  const emails = extractEmails(text, c.domain).filter((e) => e.generic); // Faz 1b: yalnız jenerik kurumsal kutu (KVKK hijyeni)
  let contacts = 0;
  for (const e of emails) {
    const ins = await query<{ id: number }>(
      `insert into lead_contacts(company_id, email, is_generic_corporate, email_status, status, evidence_url)
       values ($1,$2,true,'unknown','new',$3) on conflict (email) do nothing returning id`,
      [companyId, e.email, url],
    );
    const id = ins.rows[0]?.id;
    if (id) {
      contacts++;
      await enqueue({ loop: "leadgen", kind: "leadgen:verify", payload: { contactId: id }, dedupeKey: `verify:${e.email}` });
    }
  }
  await audit({ loop: "leadgen", action: "enrich.done", target: c.name, detail: { icp, segment: normSegment(cls.segment), contacts } });
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
