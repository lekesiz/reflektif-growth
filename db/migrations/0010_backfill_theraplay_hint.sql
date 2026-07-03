-- 0010 · Theraplay kaynağının segment_hint backfill'i.
-- Bug: 0007 Theraplay'i segment_hint='b2b_pro' ile INSERT etmeye çalışıyor ama satır zaten `add-source`
-- ile (hint'siz) eklenmişti → `on conflict (url) do nothing` insert'i atladı, TAKİP EDEN UPDATE yoktu →
-- segment_hint NULL kaldı, b2b_pro enrich-hint iyileştirmesi canlıda ATIL. (0009 yeni kaynaklarda bu
-- tuzağı insert-sonrası explicit UPDATE ile çözdü; 0007 backfill edilmemişti.)
-- Etki: bu hint enrich sınıflamasında b2b_pro isabetini ~%80 → ~%93'e çıkarıyor (ölçümle doğrulandı).
update lead_sources
   set segment_hint = 'b2b_pro'
 where url = 'https://www.theraplayturkiye.org/uzman-bul/'
   and (segment_hint is null or segment_hint <> 'b2b_pro');
