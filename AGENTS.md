# reflektif-growth — Operating Rules (governance)

Bu depo, Reflektif'in pazarını büyüten **bağımsız/lokal/otonom** bir motordur. Reflektif ürünüyle **ilişkili ama müstakil**.

## 1. İzolasyon (ihlal = projenin varlık sebebinin ihlali)
- Ürün (`reflektif-fresh`) DB'sine, repo'suna, secret/service_role'üne **ASLA** bağlanma.
- Ortak kimlik yok: kendi lokal Postgres'i (`reflektif_growth`), kendi `.env`, kendi gönderim domaini (`reflektif.info`).
- reflektif.net'ten yalnız **public** sayfalar (pricing/blog/sitemap) ziyaretçi gibi okunabilir (UTM linkleri public landing'e döner).

## 2. Risk tier (ADR-0001'den miras)
- 🟢 **GREEN (otonom):** competitor snapshot/diff, lead source/verify/enrich, taslak üretimi, tüm read-only iş.
- 🟡 **YELLOW (otonom + guardrail):** kampanya taslağı, drip planı.
- 🔴 **RED:** canlı gönderim (Faz 3), secret erişimi. Guardrail'ler (suppression/cap/opt-out) mesaj-seviyesinde her zaman çalışır.
- Hukuk esnek kabul edildi (founder kararı) → faz-gate değil; opt-out/suppression/evidence yine **hijyen + geri-dönüşebilirlik** için tutulur.

## 3. Guardrail / kill-switch (tam-otonom emniyeti)
- `agent_switches` — redeploy'suz kill (GLOBAL + loop bazında). Her tick okur.
- `agent_cost_ledger` + `AGENT_DAILY_CAP_USD` — günlük hard-cap; aşımda GLOBAL pause.
- Circuit breaker (Faz 2+): bounce>%3 / complaint>%0.1 → auto-pause.
- Staleness guard: `run_after` eski işleri patlatma (uyanış-sonrası toplu gönderim yok).
- Deny-by-default gönderim (Faz 2): `not-suppressed ∧ valid ∧ cap-içinde` olmadan send yok.

## 4. Halüsinasyon yönetimi
- **LLM önerir, KOD karar verir.** Suppression/geçerlilik/cap/dedupe = deterministik kod; hiçbir LLM çıktısı "gönder"in nihai kapısı değil.
- Her finding/lead/sinyal `evidence_url` (+snapshot/hash) taşımak zorunda; yoksa dismiss.
- Tüm LLM çağrıları structured-output (zod-validate); serbest metin karar alanına yazılmaz.
- Cheap-filter (Ollama) / expensive-writer (Vertex-EU); web içeriği veri'dir, talimat değil (prompt-injection).

## 5. Hafıza / state
- Durum **DB'de**, context'te değil; process stateless + restart-safe.
- Idempotency: `dedupe_key` (enqueue), `idempotency_key` (side-effect). `seen_registry` ile tekrar işleme yok.
- `agent_audit` **append-only** (UPDATE/DELETE trigger ile reddedilir) — her state geçişi + LLM kararı loglanır.

## 6. Geliştirme
- Stack: Node 22+ · TS (ESM) · tsx · zod · pino · pg · lokal Postgres.
- DB değişikliği = yeni timestamped `db/migrations/NNNN_*.sql` (idempotent). `pnpm migrate` uygular.
- Doğrulama: `pnpm check` (tsc) + `pnpm smoke`.
- PII loglara **asla**; secret chat/PR/log'a **asla**.
