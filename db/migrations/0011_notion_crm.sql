-- 0011 · Notion 'Reflektif CRM' senkronu — oluşturduğumuz CRM sayfasını işaretle.
--
-- notion_page_id: 'Reflektif CRM' Notion database'inde bu lead için OLUŞTURDUĞUMUZ (ya da idempotent
--   sorguda bulunup eşlediğimiz) sayfanın id'si. Dolu ise `notion-sync` bu lead'i ATLAR → tekrar-sync'te
--   DUPLICATE üretmeyiz ve kullanıcının manuel sayfalarını ASLA ezmeyiz (bkz. src/notify/notion.ts).
--   NOT: Bu BİZİM CRM'imize kayıttır — lead'lere hiçbir şey gönderilmez (AGENTS.md: deny-by-default).

alter table lead_companies add column if not exists notion_page_id text;
