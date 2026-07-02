# reflektif-growth — Devir / Kaldığımız Yer

> Bu belge, oturumlar (ve hesaplar: bireysel ↔ kurumsal) arasında **kaldığımız yerden devam** için tek kaynaktır.
> Hesaptan bağımsızdır (repo'da yaşar). Yeni bir Claude oturumu bunu + `README.md` + `AGENTS.md` okuyunca tam bağlama sahip olur.
> Son güncelleme: 2026-07-02.

## Ne bu proje
Reflektif'in pazarını büyüten **bağımsız, lokal, tam-otonom** motor: competitor-intel + lead-gen + (ileride) çok-kanal outreach.
Ürün reposu `reflektif-fresh`'e / onun DB/secret'ına **SIFIR dokunuş** — "bağımsız ama ilişkili" (founder ilkesi).

## Durum: NE BİTTİ (CANLI)
- **Faz 0 — çekirdek:** kuyruk (`agent_jobs` + `claim_agent_job` FOR UPDATE SKIP LOCKED), kill-switch (`agent_switches`), günlük cost-cap (`agent_cost_ledger`), append-only denetim (`agent_audit`, UPDATE/DELETE-reddeden trigger), state-machine, launchd tick, CLI.
- **Faz 1a — competitor-intel:** snapshot → gap → digest; Ollama gap-analizi **evidence-zorunlu**, şemalı çıktı (zod).
- **Faz 1b — lead-gen (DRAFT modu):** **source → enrich → verify → draft**. **Hiçbir şey GÖNDERMEZ** → tüm çıktı `outreach_messages.status='draft_for_review'`. Deny-by-default gönderim kapısı + grounding verify-pass mevcut ama sadece HESAPLANIR.
- **Faz 1b+ — sourcing OTONOM (bu oturum):** `lead_sources` dizinlerinden kurum keşfi (`leadgen:source`). Her kaynak opsiyonel `domain_filter` (JS-regex) ile yüksek-sinyal aday üretir (naif "tüm dış link" gürültüsü yok); LLM'siz/deterministik, evidence_url = kaynak sayfa. enrich artık kurumun kendi `<title>`'ından otoriter isim çeker (numerik/isimli HTML-entity decode dahil). Manuel `add-lead` de duruyor. Seed: TR üniversiteler (Wikipedia, `\.edu\.tr$`) → uçtan-uca doğrulandı (11 üniv → enrich ICP 85 b2b_edu → grounded taslak, `sendable=false` kapıda). Founder `add-source` ile dizin ekler.
- Hepsi build+test edildi (`pnpm check` + `pnpm smoke` yeşil) ve **launchd `com.mikail.reflektif-growth.tick` (15 dk) ile çalışıyor.** (Push için son commit'e bak.)

## Nerede ne var
- Repo: `github.com/lekesiz/reflektif-growth` · lokal `~/reflektif-growth`
- DB: **lokal Postgres 15** (brew `postgresql@15`), veritabanı `reflektif_growth` (Docker YOK)
- LLM: **Ollama `qwen3:30b`** (kütle işi, ücretsiz, veri makinede) + Vertex-EU writer (creds gelince; yoksa lokal fallback)
- launchd: `~/Library/LaunchAgents/com.mikail.reflektif-growth.tick.plist`
- Migration'lar: `db/migrations/000{1,2,3}_*.sql`
- Ayrıntılı spec: `~/reflektif-growth-SPEC-2026-07-02.md` · Fizibilite: `~/reflektif-fresh/docs/GROWTH-ENGINE-FEASIBILITY-2026-07-02.md`
- Memory: `project_reflektif_growth` (Claude memory index'inde)

## Nasıl çalıştırılır (koddan doğrulanmış komutlar)
```bash
cd ~/reflektif-growth
pnpm migrate                      # migration'ları uygula (fail-closed)
pnpm status                       # switch + kuyruk durumu (loop bazında)
pnpm tick                         # bir turluk döngü (launchd bunu 15 dk'da bir çağırır)
pnpm worker                       # sürekli worker
pnpm reaper                       # takılı/expired job'ları toparla
pnpm cli add-source <url> [filtre] [ad]  # lead dizini ekle (tick otonom tarar; filtre=host regex ör. \.edu\.tr$)
pnpm cli list-sources             # dizinler + her birinden gelen lead sayısı
pnpm cli add-lead <domain> [ad]   # tek lead ekle (manuel curation; sourcing artık otonom)
pnpm cli pause GLOBAL <sebep>     # tüm döngüleri durdur (kill-switch)
pnpm cli resume GLOBAL            # devam
pnpm smoke                        # echo + kill-switch duman testi
pnpm check                        # tsc --noEmit
```
launchd kontrol: `launchctl list | grep reflektif` · durdur: `launchctl unload ~/Library/LaunchAgents/com.mikail.reflektif-growth.tick.plist`

## SIRADA: Faz 2 (çok-kanal gönderim) — dış-TODO bekliyor
Bunlar **dışarıdan (founder) sağlanacak** girdilerdir; gelmeden Faz 2 kodu aktive edilmez:
- [ ] `reflektif.info` DNS: SPF + DKIM + DMARC + warmup (domain kayıtlı, IONOS + Resend'de)
- [ ] Telegram bot token + chat_id (digest/alarm)
- [ ] Notion token + DB (CRM)
- [ ] Email-verify API key (MillionVerifier / ZeroBounce) — `leadgen:verify` şu an graceful `unknown` dönüyor
- [ ] GCP Vertex-EU proje + service-account (writer'ı Ollama fallback'ten Gemini'ye taşımak için)
- [ ] WhatsApp Business API + LinkedIn yöntem kararı
- [x] ~~Lead sourcing otomasyonu~~ → ✅ YAPILDI (generic dizin-scraping + `domain_filter`). Genişletme (founder): `add-source` ile daha çok TR dizin ekle. Not: YÖK/MEB sayfaları JS-render/statik-değil → `leadgen:source` yalnız statik-HTML link listelerini çeker; JS-render dizinler için ayrı bir renderer (Faz 2+) gerekir.

## Değişmez ilkeler (yeni oturum bunlara uy)
1. **Guardrail-first.** Otonom ama kill-switch + cost-cap + deny-by-default + append-only audit hep açık. (Bkz. kapatılan `reflektif_auto_dev_loop` dersi.)
2. **Ürüne dokunma.** reflektif-fresh DB/repo/secret'ına asla yazma.
3. **LLM önerir, kod karar verir.** evidence_url zorunlu, şemalı (zod) çıktı, gönderim deny-by-default.
4. **Hukuk esnek** (founder kararı: gate değil) ama opt-out/suppression hijyen olarak kalır.
5. **Sırlar** loglara/PR'lara/chat'e asla yazılmaz; CLI ile pipe edilir.

## Bu oturumda (bireysel) yapılanların özeti
Faz 0+1a+1b sıfırdan kuruldu, 3 commit push edildi, launchd ile canlıya alındı. Bu belge devir için eklendi.

## Kurumsal (NETZ) oturumunda yapılanların özeti
Lead **sourcing otomasyonu** eklendi (leadgen boştaydı → artık otonom lead üretiyor):
`lead_sources` tablosu (migration 0004) + `leadgen:source` handler + saf `extractOrgLinks` (domain-filtreli, altyapı/iç-link/dedupe elemesi) + tick zamanlaması + `add-source`/`list-sources` CLI. enrich `<title>`'dan otoriter isim + HTML-entity decode ile güçlendirildi. `pnpm smoke` sourcing-extractor regresyon assertion'ı kapsıyor. TR üniversite seed'iyle uçtan-uca doğrulandı. Sıradaki: Faz 2 dış-TODO'ları geldikçe.
