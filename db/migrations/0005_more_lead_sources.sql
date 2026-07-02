-- 0005 · lead sourcing dizinlerini genişlet.
-- Bu kaynaklar önce workflow ile araştırılıp curl'le doğrulandı ve `pnpm cli add-source` ile
-- canlı DB'ye eklendi; bu migration yalnız kod/DB tutarlılığı için aynı seed'i idempotent kaydeder
-- (temiz kurulum / DB sıfırlama durumunda kaynaklar kaybolmasın).
insert into lead_sources (name, url, domain_filter, segment_hint, notes) values
  (
    'Toptalent.co – Türkiye''deki Üniversiteler Listesi (devlet+vakıf, tam liste)',
    'https://toptalent.co/turkiyedeki-universiteler-listesi',
    '\.edu\.tr$',
    'b2b_edu',
    'Wikipedia kaynağını tamamlar; devlet+vakıf ayrımı yapmadan tam liste, ~202 .edu.tr domaini'
  ),
  (
    'TÖZOK - Türkiye Özel Okullar Derneği (Üye Okullar)',
    'https://www.tozok.org.tr/uye-okullar',
    null,
    'b2b_edu',
    'Özel K-12 okulları — adanmış üye-okullar alt-sayfası (ana sayfa değil)'
  ),
  (
    'Ege Özel Okullar Derneği (Üye Okullar)',
    'http://www.egeozelokulder.org.tr/uye-okullar',
    null,
    'b2b_edu',
    'Bölgesel (Ege/İzmir) özel okullar; TÖZOK ile büyük ölçüde tekrarsız'
  ),
  (
    'İKMD (İnsan Kaynakları Meslek Derneği) — Kurumsal Üyeler',
    'https://ikmd.org.tr/kurumsal-uyeler',
    null,
    'b2b2c_ld',
    'İK derneği kurumsal üye listesi'
  ),
  (
    'MÜSİAD Sakarya - Üyeler',
    'https://sakaryamusiad.org.tr/uyeler',
    null,
    'b2b2c_ld',
    'Sanayici/işadamı derneği üye şirketleri (Sakarya)'
  ),
  (
    'TESİD (Türk Elektronik Sanayicileri Derneği) - Üyelerimiz',
    'https://tesid.org.tr/uyelerimiz',
    null,
    'b2b2c_ld',
    'Elektronik/savunma sanayii üye firmaları'
  ),
  (
    'TÜBİSAD (Türkiye Bilişim Sanayicileri Derneği) - Kurumsal Üyelerimiz',
    'https://www.tubisad.org.tr/tr/uyelik/detay/Uye-Listesi/213/4206/0',
    null,
    'b2b2c_ld',
    'Bilişim sektörü kurumsal üyeleri — en zengin aday (~251 dış host)'
  )
on conflict (url) do nothing;
