-- 0002 · rakip seed (curated başlangıç — Faz 1 kalibrasyonunda genişletilir) + compintel loop'u aç
-- URL'ler gerçek/doğrulanabilir; pricing/changelog belirsizse NULL bırakıldı (snapshot homepage'e düşer).

create unique index if not exists uq_competitors_homepage on competitors(homepage);

insert into competitors (name, homepage, pricing_url, changelog_url) values
  ('16Personalities', 'https://www.16personalities.com', null, null),
  ('Truity',          'https://www.truity.com',          null, null),
  ('CareerExplorer',  'https://www.careerexplorer.com',  null, null),
  ('JobTeaser',       'https://www.jobteaser.com',       null, null),
  ('Kariyer.net',     'https://www.kariyer.net',         null, null),
  ('Youthall',        'https://www.youthall.com',        null, null)
on conflict (homepage) do nothing;

-- compintel dış-etkisiz (public sayfa fetch + lokal LLM); güvenle açılır.
update agent_switches set enabled=true, updated_by='migration-0002', updated_at=now() where loop='compintel';
