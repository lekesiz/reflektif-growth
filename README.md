# reflektif-growth

Bağımsız, **lokal**, tam-otonom büyüme-destek motoru: competitor-intel + lead-gen + çok-kanal outreach.
**Reflektif ürünü (reflektif.net) ile SIFIR paylaşım** — ürün DB/repo/secret'ına dokunmaz; yalnız public sayfaları okur.

> Spec: `~/reflektif-growth-SPEC-2026-07-02.md` · Fizibilite: `reflektif-fresh/docs/GROWTH-ENGINE-FEASIBILITY-2026-07-02.md`

## Durum
- **Faz 0 (iskele)** — ✅ lokal Postgres şeması + kuyruk (`agent_jobs` + `claim_agent_job` SKIP LOCKED) + kill-switch + cost-cap + append-only audit + state-machine + launchd tick + CLI.
- **Faz 1a (competitor-intel)** — ✅ snapshot → gap → digest.
- **Faz 1b (lead-gen DRAFT)** — ✅ **source** → enrich → verify → draft. Sourcing OTONOM: `lead_sources` dizinlerinden (`domain_filter` regex ile yüksek-sinyal) kurum keşfi; enrich `<title>`'dan otoriter isim + ICP; her çıktı `draft_for_review` (GÖNDERİM YOK).
- Faz 2 (çok-kanal gönderim), Faz 3 (tam-otonom canlı ramp) — sırada (dış-TODO bekliyor).

## Kurulum (lokal, Docker gerekmez)
```bash
# Postgres 15 (brew) çalışır durumda + DB:
#   brew services start postgresql@15 && createdb reflektif_growth
cp .env.example .env         # DATABASE_URL'i doğrula
pnpm install
pnpm migrate                 # şemayı uygula
pnpm smoke                   # uçtan-uca doğrulama (enqueue→claim→done + idempotency + kill-switch)
```

## Komutlar
| Komut | İş |
|---|---|
| `pnpm migrate` | Bekleyen SQL migration'ları uygula |
| `pnpm tick` | launchd entrypoint: reaper + GLOBAL-kontrol + worker turları |
| `pnpm status` | switches + job sayıları + günlük maliyet + son audit |
| `pnpm smoke` | Faz 0 + sourcing-extractor uçtan-uca test |
| `pnpm secrets:pull` | `.env` sırlarını lokal kasadan (`secret` CLI / macOS Keychain) tazeler — sır-olmayan config'e dokunmaz |
| `pnpm notion:sync [--dry-run] [--limit N]` | Enrich edilmiş bizim-kaynaklı lead'leri Notion "Reflektif CRM"e yazar (idempotent+tahribatsız; manuel kayıtlara dokunmaz) |
| `pnpm cli drafts [--limit N] [--segment X] [--full]` | Gönderilmesi planlanan taslakları incele (salt-okunur; gönderim YOK) |
| `pnpm cli add-source <url> [filtre] [ad]` | lead dizini ekle (tick otonom tarar; `filtre` = host JS-regex, ör. `\.edu\.tr$`) |
| `pnpm cli list-sources` | tanımlı dizinler + her birinden gelen lead sayısı |
| `pnpm cli add-lead <domain> [ad]` | tek lead ekle (manuel curation) |
| `pnpm cli pause <loop> <sebep>` / `resume <loop>` | kill-switch (`GLOBAL`/`compintel`/`leadgen`/`test`) |
| `pnpm reaper` | lease'i geçmiş işleri geri al |

## İlkeler (kısa)
- **İzolasyon:** ürün DB/secret'ı asla; kendi lokal Postgres'i.
- **Tam otonom + guardrail:** kill-switch (`agent_switches`) · günlük cost-cap (`agent_cost_ledger`) · append-only audit · staleness/backoff · deny-by-default gönderim (Faz 2).
- **Halüsinasyon:** LLM önerir, **KOD karar verir**; her finding `evidence_url` zorunlu; structured-output (zod).
- **Hafıza:** durum context'te değil **DB'de**; idempotency (`dedupe_key`), `seen_registry`, restart-safe.
- **Sırlar:** tek kaynak lokal kasa (macOS Keychain, `~/.local/bin/secret`); `.env` türetilmiş artefakt (gitignore'lu, `pnpm secrets:pull` ile yeniden üretilir). Anahtar adı = env değişkeni adı. launchd `.env` okur (headless Keychain erişemez).

Detay ve tier modeli: [AGENTS.md](./AGENTS.md).
