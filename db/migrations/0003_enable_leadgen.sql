-- 0003 · leadgen loop'u aç.
-- Faz 1b DRAFT modu: pipeline yalnız enrich→verify→draft yapar, HİÇBİR ŞEY GÖNDERMEZ
-- (tüm çıktı outreach_messages.status='draft_for_review'). Gönderim Faz 3'te (RED, guardrail'li).
update agent_switches set enabled=true, updated_by='migration-0003', updated_at=now() where loop='leadgen';
