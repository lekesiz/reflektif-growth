-- 0013 · ENTITY-GUARD veri düzeltmesi (mevcut kayıtlar).
-- Canlı ölçüm: enrich, sanayi/teknopark firmalarını (tacir = şirket) yanlışlıkla 'b2b_pro' sınıflandırdı —
-- oysa b2b_pro = tek gerçek kişinin kendi adıyla yürüttüğü BİREYSEL pratik (entity_type='birey').
-- Bir tacir/kamu/bilinmiyor tüzel kişilik b2b_pro OLAMAZ → kurumsal segment b2b2c_ld'ye düşürülür.
-- İdempotent: yalnız ÇELİŞKİLİ (b2b_pro + birey-olmayan) kayıtları düzeltir; b2b_pro + birey gerçek
-- bireysel profesyoneller DOKUNULMAZ (email-istisnası/consent_basis bozulmaz). Kod-kapısı resolveSegment()
-- bundan sonra aynı çelişkiyi enrich anında engeller; bu migration re-enrich'siz geçmişi hizalar.
update lead_companies
   set segment = 'b2b2c_ld'
 where segment = 'b2b_pro'
   and entity_type <> 'birey';
