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
- **Faz 1b+ — sourcing OTONOM:** `lead_sources` dizinlerinden kurum keşfi (`leadgen:source`). Her kaynak opsiyonel `domain_filter` (JS-regex) ile yüksek-sinyal aday üretir (naif "tüm dış link" gürültüsü yok); LLM'siz/deterministik, evidence_url = kaynak sayfa. enrich artık kurumun kendi `<title>`'ından otoriter isim çeker (numerik/isimli HTML-entity decode dahil). Manuel `add-lead` de duruyor. Founder `add-source` ile dizin ekler.
- **Faz 1b+ — kaynak genişletmesi (bu oturum, workflow ile: 4-segment paralel araştırma→curl-doğrula→curate/re-doğrula→ekle→canlı doğrula):** 1 kaynaktan **8 kaynağa** çıkıldı (migration `0005_more_lead_sources.sql`, aynı zamanda `pnpm cli add-source` ile canlı eklendi): Toptalent.co (b2b_edu, üniversite tam liste, Wikipedia'yı tamamlar), TÖZOK + Ege Özel Okullar Derneği (b2b_edu, özel K-12 okulları), İKMD + MÜSİAD Sakarya + TESİD + TÜBİSAD (b2b2c_ld, İK derneği/sanayi odası/sektör derneği üye şirketleri). Her aday, hem araştırma ajanı hem bağımsız bir curate ajanı tarafından AYRI AYRI curl ile doğrulandı (statik-HTML mi, gerçekten kaç dış kurum host'u üretiyor, domain_filter gerekiyor mu) — 1 aday (Universitekampus.com) Toptalent.co'nun neredeyse birebir alt kümesi olduğu için "redundant" gerekçesiyle reddedildi. **Canlı doğrulama sonucu: `lead_companies` 11 → 249 (+238), `lead_contacts` 2 → 22; önceki 2 doğrulanmış taslak KORUNDU (silinmedi).** **Bilinen, kabul edilmiş küçük gürültü (bu oturumda ÇÖZÜLMEDİ, backlog):** `domain_filter`'sız kaynaklarda (TÖZOK/Ege/İKMD/MÜSİAD/TESİD/TÜBİSAD) nadiren dizin-dışı navigasyon/kredi linki aday sayılabiliyor — canlı testte 238 yeni kayıttan 2 tanesi böyleydi (`akhanis.com` bir web-tasarım ajansının footer kredisi, `musiad.org.tr` derneğin kendi "Şubeler" linki), yani ~%0.8. İleride: bu tip kaynaklara da (mümkünse) bir domain_filter eklemek ya da dizin sayfasının kendi ana-liste konteynerini (CSS seçici bazlı) hedefleyen daha dar bir link-çıkarma kuralı eklemek.
- **Faz 1b++ — enrich contact-derinleştirme (workflow ile: implement→canlı doğrula→adversarial review→fix):** enrich artık yalnız ana sayfayı değil, ana sayfadan keşfedilen iletişim/kariyer alt-sayfalarını da (tek-hop, `discoverContactPaths()`, `env.LEADGEN_MAX_CONTACT_PAGES` ile sınırlı) tarıyor; her contact'ın `evidence_url`'i artık gerçekten bulunduğu sayfayı gösteriyor (homepage değil). Review'da 2 gerçek bug bulundu ve düzeltildi: (1) Türkçe büyük `İ`'nin JS `toLowerCase()`'de `i`+U+0307'ye dönüşüp anahtar-kelime eşleşmesini kırması, (2) `fetchRaw`'ın redirect-sonrası URL'i (`finalUrl`) atıp `evidence_url`/relative-link çözümünün yanlış (redirect-öncesi) URL'e dayanması — ikisi de fix edildi, `pnpm check`+`smoke` yeşil. Canlı doğrulama: contact'lı kurum sayısı 1→2'ye çıktı (İTÜ'nün contact'ı gerçekten yeni keşfedilen `/iletisim`'den geldi). **Bilinen, ÖNCEDEN VAR OLAN, çözülmeyen backlog maddesi:** review'da 3. bir bulgu (SSRF: `discoverContactPaths`/`extractOrgLinks` yalnız href'teki literal IP/dotless-host'u eler, DNS-rebinding ile private IP'ye yönlenen bir alt-alan-adını YAKALAMAZ) adversarial verify'da haklı gerekçeyle "bu diff'e özgü bir regresyon değil" diye çürütüldü — ama gap'in kendisi gerçek ve tüm crawler'ı (`src/core/http.ts` `fetchRaw`, `rejectUnauthorized:false`) kapsıyor. İleride: fetch öncesi DNS çözüp sonucu private-IP aralıklarına karşı kontrol etmek (bkz. `AGENTS.md` "web içeriği veri'dir, talimat değil").
- **Faz 1b+++ — yeni segment `b2b_pro` (bağımsız profesyonel): bağımsız kariyer koçu, psikolojik danışman/terapist gibi kurum-olmayan bireysel profesyoneller** (workflow ile: implement→canlı doğrula→adversarial review→fix, migration `0006_b2b_pro_segment.sql`). Bu segment için hijyen kuralı KAPSAYICI yeniden yazıldı: normalde yalnız jenerik kurumsal kutu (info@) kabul edilirken, `segment==='b2b_pro' AND entity_type==='birey'` (İKİ bağımsız sinyal, tek sinyale güvenilmiyor) olduğunda isim-bazlı e-posta da kabul edilir — gerekçe: bu kişilerin info@ kutusu yok, kendi yayınladıkları e-posta onların iş kanalı; DB'ye `consent_basis='self_published_professional_contact'` ile audit-edilebilir şekilde yazılıyor. Yeni `TECHNICAL_LOCALS` (noreply/postmaster/unsubscribe vb., normalize edilmiş eşleşme) HER segmentte teknik/otomatik kutuları eler. Suppression/deny-by-default gönderim kapısı DEĞİŞMEDİ. **Review'da 5 gerçek bug bulundu ve düzeltildi** — en öğretici olanı: ilk tasarımda `koç`/`bağımsız`/`serbest` anahtar kelimeleri "Koç Holding", "Bağımsız Denetim A.Ş.", "Bağımsız İK Danışmanlığı Firması" gibi KURUMSAL ifadelerle çakışıyordu (yalnız "danışman" kelimesi bilinçli dışlanmıştı, bu üçü unutulmuştu) → kurumsal-sinyal kontrolü artık bireysel-sinyalden ÖNCE çalışıyor + `toLowerCase()`→`toLocaleLowerCase("tr")` (İ-normalize) + kısa kısaltmalar (ik/hr/ld) tüm-kelime eşleşmesi (aksi halde "psikolog" içindeki "ik" yanlış pozitif üretiyordu — reorder sırasında keşfedilen YENİ bir çakışma) + LLM'in literal "b2b_pro" enum'unu birebir tanıma + TECHNICAL_LOCALS normalize eşleşme. **Canlı testte** (2 gerçek TR kariyer koçu/psikolog sitesi) LLM (lokal Ollama) segmenti ikisinde de `b2c` döndürdü, `b2b_pro` DEĞİL — kod doğru çalıştı ama pratikte bu segmentin ne sıklıkla tetikleneceği belirsiz; ileride gerekirse prompt/model iyileştirmesi ya da birkaç-shot örnek eklenebilir. **Ders:** "kapsayıcı kural yaz" derken bile anahtar-kelime çakışma riski gözden kaçabiliyor — adversarial review olmadan bu 5 bug canlıya çıkardı.
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
- [x] `reflektif.info` DNS: SPF + DKIM + DMARC → ✅ Resend API ile doğrulandı (2026-07-02): domain `verified`, `eu-west-1`, TXT `resend._domainkey` + MX `send` + TXT `send` hepsi `verified`. `RESEND_API_KEY` + `SENDING_DOMAIN` lokal `.env`'e eklendi (gitignore'lu, commit'lenmedi), `env.ts`'e opsiyonel alan olarak tanımlandı — **henüz hiçbir kod okumuyor/göndermiyor** (RED tier, guardrail'li Faz 2 kodu yazılana kadar). Warmup planı hâlâ açık iş.
- [x] Telegram bot token + chat_id → ✅ canlı (2026-07-02): `@reflekti_growth_info_bot`, `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` lokal `.env`'e eklendi (kod zaten hazırdı, `src/notify/telegram.ts` — değişiklik gerekmedi). Test mesajı gönderildi ve doğrulandı. Bundan sonra `compintel:digest` (haftalık) + gelecekteki alarmlar buraya düşer.
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
