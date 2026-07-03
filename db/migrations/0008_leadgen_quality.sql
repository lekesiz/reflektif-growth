-- 0008 · leadgen kalite: per-kaynak exclude_domains + bilinen gürültü temizliği.
--
-- exclude_domains: opsiyonel JS-regex (HOST'a uygulanır). extractOrgLinks'te domain_filter/infra/iç-link
--   elemesine EK bir negatif filtredir — dizin sayfasında karışan dernek-ekosistemi / web-ajansı / gov
--   host'larını aday olmaktan çıkarır. null = filtre yok. Bozuk regex → fail-open (kodda yok sayılır).
--   LLM önerir değil; KOD deterministik süzer (AGENTS.md §4).

alter table lead_sources add column if not exists exclude_domains text;

-- Bilinen gürültü kaynaklarına set (idempotent; url'ler 0004/0005 seed'i ile birebir):
-- MÜSİAD Sakarya dizini derneğin kendi ana domaini (musiad.org.tr) "üye" gibi çekiyordu.
update lead_sources set exclude_domains = '(^|\.)musiad\.org\.tr$'
 where url = 'https://sakaryamusiad.org.tr/uyeler';
-- TÖZOK dizini siteyi yapan web-ajansının domaini (akhanis.com) "üye okul" gibi çekiyordu.
update lead_sources set exclude_domains = '(^|\.)akhanis\.com$'
 where url = 'https://www.tozok.org.tr/uye-okullar';

-- Veri temizliği: yukarıdaki iki gürültü domaini için önceden girmiş kayıtları sil
-- (lead_contacts + outreach_messages ON DELETE CASCADE ile birlikte gider — sorun değil, Faz 1b DRAFT).
delete from lead_companies where domain in ('akhanis.com', 'musiad.org.tr');
