-- 0009 · lead sourcing dizinlerini genişlet (v2 — teknopark/OSB üye firma dizinleri).
-- Bu kaynaklar önce bağımsız curl doğrulamasından geçti (HTTP 200, statik HTML, JS-render markerı yok,
-- extractOrgLinks ile temiz üye-firma domainleri) ve `pnpm cli add-source` ile canlı DB'ye eklendi;
-- bu migration aynı seed'i idempotent kaydeder (temiz kurulum / DB sıfırlamada kaynak kaybolmasın).
--
-- add-source segment_hint/exclude_domains'i SET ETMEZ → insert on-conflict-do-nothing ile birleşince
-- bu iki alan boş kalırdı. Bu yüzden insert'ten SONRA her URL için idempotent UPDATE ile set edilir
-- (fresh DB'de insert zaten doğru değeri koyar; UPDATE no-op olur → her iki yol da aynı sonuca yakınsar).
insert into lead_sources (name, url, domain_filter, segment_hint, notes, exclude_domains) values
  (
    'ODTÜ Teknokent — Tüm Firmalar',
    'https://odtuteknokent.com.tr/tr/firmalar/tum-firmalar.php',
    null,
    'b2b2c_ld',
    'En zengin aday: 387 benzersiz dış host, exclude sonrası 383 temiz üye-firma domaini. exclude 4 gürültü host''unu (metu.edu.tr, tto.metu.edu.tr, atom.org.tr, asoteknopark.com.tr) eler.',
    '(^|\.)(metu\.edu\.tr|atom\.org\.tr|asoteknopark\.com\.tr)$'
  ),
  (
    'YTÜ Yıldız Teknopark — Firmalarımız',
    'https://www.yildizteknopark.com.tr/firmalarimiz',
    null,
    'b2b2c_ld',
    'Statik HTML, 28 benzersiz dış host; exclude sonrası 27 temiz üye-firma domaini (akinon.com, etiya.com, papara.com ...). exclude tek gürültü host''unu (yildiz.edu.tr) eler.',
    '(^|\.)yildiz\.edu\.tr$'
  ),
  (
    'OİB (Orta Anadolu İhracatçı Birlikleri) — Üye Firmalar',
    'https://oib.org.tr/tr/members.html',
    null,
    'b2b2c_ld',
    'Makine/metal/otomotiv/tekstil ihracatçısı üye firmaları; 25 dış host, exclude sonrası 18 temiz. exclude 7 dernek-ekosistemi/gov gürültüsünü eler.',
    '(^|\.)(uib\.org\.tr|tim\.org\.tr|oibventure\.com|ekonomi\.gov\.tr|ticaret\.gov\.tr|360-management\.com)$'
  ),
  (
    'Bilkent CYBERPARK — Firma Arşivi',
    'https://www.cyberpark.com.tr/firma-arsiv',
    null,
    'b2b2c_ld',
    'En zayıf ama geçerli aday (dizinin sadece 1. sayfası): 12 dış host, exclude sonrası 7 temiz üye-firma domaini. exclude ŞART — 5 gürültü host''unu (bilkent.edu.tr, bilkentholding.com.tr, e-sirket.mkk.com.tr, sanayi.gov.tr, omedya.com) eler.',
    '(^|\.)(bilkent\.edu\.tr|bilkentholding\.com\.tr|mkk\.com\.tr|omedya\.com|sanayi\.gov\.tr)$'
  )
on conflict (url) do nothing;

-- add-source ile önceden eklenmiş satırlarda segment_hint/exclude_domains boş kalmış olabilir → idempotent set.
update lead_sources set segment_hint = 'b2b2c_ld', exclude_domains = '(^|\.)(metu\.edu\.tr|atom\.org\.tr|asoteknopark\.com\.tr)$'
 where url = 'https://odtuteknokent.com.tr/tr/firmalar/tum-firmalar.php';
update lead_sources set segment_hint = 'b2b2c_ld', exclude_domains = '(^|\.)yildiz\.edu\.tr$'
 where url = 'https://www.yildizteknopark.com.tr/firmalarimiz';
update lead_sources set segment_hint = 'b2b2c_ld', exclude_domains = '(^|\.)(uib\.org\.tr|tim\.org\.tr|oibventure\.com|ekonomi\.gov\.tr|ticaret\.gov\.tr|360-management\.com)$'
 where url = 'https://oib.org.tr/tr/members.html';
update lead_sources set segment_hint = 'b2b2c_ld', exclude_domains = '(^|\.)(bilkent\.edu\.tr|bilkentholding\.com\.tr|mkk\.com\.tr|omedya\.com|sanayi\.gov\.tr)$'
 where url = 'https://www.cyberpark.com.tr/firma-arsiv';
