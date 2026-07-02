-- Yeni segment: b2b_pro (bağımsız kariyer koçu / psikolojik danışman / terapist gibi BİREYSEL
-- profesyoneller — kurum değil, aracı bizzat kendi pratiğinde kullanan kişi). entity_type'a
-- dokunulmuyor: mevcut 'birey' değeri bu profesyoneller için zaten yeterli.
alter table lead_companies drop constraint lead_companies_segment_check;
alter table lead_companies add constraint lead_companies_segment_check check (segment = any (array['b2b_edu','b2b2c_ld','b2b_pro','b2c']));
