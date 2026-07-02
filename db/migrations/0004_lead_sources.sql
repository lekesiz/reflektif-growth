-- 0004 · leadgen sourcing otomasyonu.
-- Manuel `add-lead` yerine dizin/liste sayfalarından OTONOM lead keşfi.
-- Akış: tick → leadgen:source (dizin sayfasını çek, kurum linklerini DETERMİNİSTİK çıkar) →
--        lead_companies insert → leadgen:enrich (mevcut pipeline). Hiçbir şey GÖNDERMEZ (Faz 1b).
--
-- domain_filter: opsiyonel JS-regex (host'a uygulanır) — naif "tüm dış linkler" gürültüsünü keser,
--   yalnız ICP'ye uygun domainleri (ör. .edu.tr) aday yapar. LLM önerir değil; KOD deterministik süzer.

create table if not exists lead_sources (
  id            bigint generated always as identity primary key,
  name          text        not null,
  url           text        not null,
  domain_filter text,                    -- opsiyonel JS-regex; host eşleşmezse aday değil
  segment_hint  text,                    -- b2b_edu | b2b2c_ld | b2c (bilgi amaçlı; enrich yine sınıflar)
  active        boolean     not null default true,
  notes         text,
  created_at    timestamptz not null default now()
);
create unique index if not exists uq_lead_sources_url on lead_sources(url);

-- Doğrulanmış seed: TR üniversite listesi (statik, resmi .edu.tr domainleri) →
-- üniversite kariyer merkezleri = yüksek-ICP (b2b_edu). Founder CLI ile `add-source` ekler.
insert into lead_sources (name, url, domain_filter, segment_hint, notes) values
  (
    'TR Üniversiteler (Wikipedia)',
    'https://tr.wikipedia.org/wiki/T%C3%BCrkiye%27deki_%C3%BCniversiteler_listesi',
    '\.edu\.tr$',
    'b2b_edu',
    'Üniversite kariyer merkezleri — resmi .edu.tr homepage linkleri'
  )
on conflict (url) do nothing;
