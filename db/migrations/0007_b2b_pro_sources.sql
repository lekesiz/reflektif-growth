-- 0007 · b2b_pro segmenti için lead sourcing dizini ekle.
-- Bu kaynak önce workflow ile araştırılıp curl'le doğrulandı ve `pnpm cli add-source` ile
-- canlı DB'ye eklendi; bu migration yalnız kod/DB tutarlılığı için aynı seed'i idempotent kaydeder
-- (temiz kurulum / DB sıfırlama durumunda kaynak kaybolmasın).
insert into lead_sources (name, url, domain_filter, segment_hint, notes) values
  (
    'Theraplay Oyun ve Aile Terapileri Derneği — Uzman Bul',
    'https://www.theraplayturkiye.org/uzman-bul/',
    null,
    'b2b_pro',
    'Bağımsız oyun/aile terapisti dizini — ~226 üyeden ~64 benzersiz harici profesyonel domain (kendi sitesi olan bağımsız terapistler); dernek içi profil sayfası sistemi yok'
  )
on conflict (url) do nothing;
