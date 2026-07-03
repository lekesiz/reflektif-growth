-- 0012 · lead sourcing dizinlerini genişlet (v3 — TED Kolejleri K-12 dizini).
-- Bu kaynak önce bağımsız curl doğrulamasından geçti (UA reflektif-growth-bot: HTTP 200, ~294 KB statik
-- WordPress HTML — AIOSEO generator; __NEXT_DATA__/id=root/ng-app/__nuxt/data-reactroot JS-render markerı
-- YOK) ve `pnpm cli add-source` ile canlı DB'ye eklendi; bu migration aynı seed'i idempotent kaydeder
-- (temiz kurulum / DB sıfırlamada kaynak kaybolmasın).
--
-- add-source segment_hint/exclude_domains'i SET ETMEZ → insert on-conflict-do-nothing ile birleşince
-- bu iki alan boş kalırdı. Bu yüzden insert'ten SONRA her URL için idempotent UPDATE ile set edilir
-- (fresh DB'de insert zaten doğru değeri koyar; UPDATE no-op olur → her iki yol da aynı sonuca yakınsar).
--
-- exclude_domains bu kaynakta GEREKMEZ (null): extractOrgLinks → 52 benzersiz dış host, domain_filter
-- '\.k12\.tr$' uygulanınca 51 temiz bağımsız TED koleji .k12.tr domaini kalır. Tek gürültü tedu.edu.tr
-- (üniversite) zaten domain_filter ile ELENİR → ayrıca exclude'a gerek yok.
insert into lead_sources (name, url, domain_filter, segment_hint, notes) values
  (
    'TED Okulları — Okullarımız (TED Kolejleri, K-12)',
    'https://ted.org.tr/tedokullari/okullarimiz/',
    '\.k12\.tr$',
    'b2b_edu',
    'Adanmış /okullarimiz/ alt-sayfası; 132 anchor, extractOrgLinks → 52 dış host, domain_filter ''\.k12\.tr$'' sonrası 51 temiz K-12 kolej domaini (tedankara/tedistanbul-atakent/uskudar/tedizmir/tedbursa/tedkonya... ~45 il + KKTC). Her koleji kendi .k12.tr domaininde bağımsız → K-12 okul kariyer/rehberlik merkezleri (b2b_edu). exclude_domains gerekmez: tek gürültü tedu.edu.tr (üni) domain_filter ile elenir.'
  )
on conflict (url) do nothing;

-- add-source ile önceden eklenmiş satırda segment_hint boş kalmış olabilir → idempotent set.
-- exclude_domains bu kaynakta bilinçli olarak null (yukarıdaki gerekçe) — pattern gereği açıkça set edilir.
update lead_sources set segment_hint = 'b2b_edu', exclude_domains = null
 where url = 'https://ted.org.tr/tedokullari/okullarimiz/';
