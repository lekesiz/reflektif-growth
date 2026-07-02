-- reflektif-growth · 0001_init · shared substrate + control-plane + domain tables
-- Idempotent (tekrar çalıştırılabilir). PG13+ (gen_random_uuid core'da; extension gerekmez).
-- Not: bu proje ürün DB'sine BAĞLANMAZ; kendi lokal DB'sidir.

-- ============================ ENUMS ============================
do $$ begin
  create type agent_job_status as enum ('pending','claimed','running','done','failed','dead','blocked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lead_status as enum ('new','verified','enriched','drafted','queued','sent','replied','hot','suppressed','dead');
exception when duplicate_object then null; end $$;

-- ============================ QUEUE ============================
create table if not exists agent_jobs (
  id            bigint generated always as identity primary key,
  loop          text not null check (loop in ('compintel','leadgen','test')),
  kind          text not null,
  payload       jsonb not null default '{}',
  priority      int  not null default 100,          -- düşük = önce
  risk_tier     text not null default 'green' check (risk_tier in ('green','yellow','red')),
  status        agent_job_status not null default 'pending',
  dedupe_key    text unique,                        -- aynı işi iki kez enqueue etme
  attempts      int  not null default 0,
  max_attempts  int  not null default 3,
  locked_by     text,
  locked_until  timestamptz,
  run_after     timestamptz not null default now(), -- gecikmeli/backoff/staleness
  last_error    text,
  cost_usd      numeric(10,4) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_agent_jobs_claim on agent_jobs (loop, status, run_after, priority);

-- Tek atomik claim (FOR UPDATE SKIP LOCKED) — çok-tüketici güvenli, cluster-hazır.
create or replace function claim_agent_job(p_loop text, p_kinds text[], p_worker text, p_lease_seconds int)
returns setof agent_jobs
language plpgsql as $$
begin
  return query
  update agent_jobs j
     set status='claimed', locked_by=p_worker,
         locked_until = now() + make_interval(secs => greatest(p_lease_seconds,1)),
         attempts = attempts + 1, updated_at = now()
   where j.id = (
     select id from agent_jobs
      where loop = p_loop and kind = any(p_kinds)
        and status = 'pending' and run_after <= now()
      order by priority, created_at
      for update skip locked
      limit 1)
  returning j.*;
end; $$;

-- ============================ CONTROL PLANE ============================
-- Kill-switch (redeploy'suz; her tick okur)
create table if not exists agent_switches (
  loop          text primary key,       -- 'GLOBAL' | 'compintel' | 'leadgen' | 'test'
  enabled       boolean not null default false,
  paused_reason text,
  updated_by    text,
  updated_at    timestamptz not null default now()
);
insert into agent_switches (loop, enabled, updated_by) values
  ('GLOBAL', true,  'migration'),
  ('test',   true,  'migration'),
  ('compintel', false, 'migration'),
  ('leadgen',   false, 'migration')
on conflict (loop) do nothing;

-- Maliyet defteri (günlük hard-cap enforcement)
create table if not exists agent_cost_ledger (
  id            bigint generated always as identity primary key,
  loop          text not null,
  job_id        bigint references agent_jobs(id) on delete set null,
  model         text,
  provider      text,
  input_tokens  int,
  output_tokens int,
  usd           numeric(10,4) not null default 0,
  at            timestamptz not null default now()
);
create index if not exists idx_cost_loop_at on agent_cost_ledger (loop, at);

-- Append-only denetim (UPDATE/DELETE trigger ile reddedilir)
create table if not exists agent_audit (
  id         bigint generated always as identity primary key,
  loop       text,
  actor      text,
  action     text not null,
  target     text,
  risk_tier  text,
  decision   text,             -- 'auto'|'gated'|'human_approved'|'vetoed'|'blocked'
  detail     jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index if not exists idx_audit_at on agent_audit (at desc);

create or replace function agent_audit_no_mutate() returns trigger
language plpgsql as $$
begin
  raise exception 'agent_audit is append-only (% not allowed)', tg_op;
end; $$;
drop trigger if exists trg_agent_audit_no_update on agent_audit;
drop trigger if exists trg_agent_audit_no_delete on agent_audit;
create trigger trg_agent_audit_no_update before update on agent_audit for each row execute function agent_audit_no_mutate();
create trigger trg_agent_audit_no_delete before delete on agent_audit for each row execute function agent_audit_no_mutate();

-- ============================ DOMAIN (Faz 1+ doldurur; şema şimdi stabil) ============================
create table if not exists lead_companies (
  id             bigint generated always as identity primary key,
  name           text not null,
  domain         text unique,
  segment        text check (segment in ('b2b_edu','b2b2c_ld','b2c')),
  entity_type    text check (entity_type in ('tacir','kamu','birey','bilinmiyor')) default 'bilinmiyor',
  region         text,
  source         text,
  evidence_url   text,
  tech_stack     jsonb not null default '{}',
  signals        jsonb not null default '{}',
  icp_score      int check (icp_score between 0 and 100),
  created_at     timestamptz not null default now()
);

create table if not exists lead_contacts (
  id              bigint generated always as identity primary key,
  company_id      bigint references lead_companies(id) on delete cascade,
  full_name       text,
  role            text,
  email           text unique,
  is_generic_corporate boolean not null default false,  -- info@/ik@ = kişisel-veri-değil argümanı
  email_status    text check (email_status in ('valid','risky','invalid','unknown')) default 'unknown',
  channel_hints   jsonb not null default '{}',          -- whatsapp/linkedin ipuçları
  consent_basis   text,
  lawful          boolean not null default false,       -- gönderim ÖZET izni
  status          lead_status not null default 'new',
  evidence_url    text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_contacts_company on lead_contacts (company_id);
create index if not exists idx_contacts_status on lead_contacts (status);

create table if not exists outreach_messages (
  id              bigint generated always as identity primary key,
  contact_id      bigint references lead_contacts(id) on delete cascade,
  channel         text not null check (channel in ('email','whatsapp','linkedin')),
  step            int not null default 1,
  subject         text,
  body            text,
  status          text not null default 'draft_for_review'
                    check (status in ('draft_for_review','queued','sent','opened','replied','bounced','suppressed','failed')),
  idempotency_key text unique,
  provider_msg_id text,
  scheduled_at    timestamptz,
  sent_at         timestamptz,
  sentiment       text,
  evidence_snapshot jsonb,      -- grounded-generation kanıtı (halüsinasyon guard)
  created_at      timestamptz not null default now()
);
create index if not exists idx_outreach_contact on outreach_messages (contact_id);

create table if not exists suppression_list (   -- opt-out/bounce/şikâyet = KALICI
  email     text primary key,
  reason    text,
  at        timestamptz not null default now()
);

create table if not exists consent_records (    -- opt-out / İYS-ret / evidence defteri (hijyen + geri-dönüşebilirlik)
  id          bigint generated always as identity primary key,
  email       text,
  basis       text,
  iys_status  text,             -- 'onaylı'|'ret'|'muaf_ticari'|null
  evidence    jsonb not null default '{}',
  at          timestamptz not null default now()
);

create table if not exists seen_registry (      -- content_hash "görüldü" seti (tekrar işleme yok)
  key         text primary key,                 -- ör. 'competitor:acme:pricing'
  content_hash text not null,
  seen_at     timestamptz not null default now()
);

-- Competitor-intel
create table if not exists competitors (
  id           bigint generated always as identity primary key,
  name         text not null,
  homepage     text,
  pricing_url  text,
  changelog_url text,
  rss_url      text,
  github_org   text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists competitor_snapshots (
  id            bigint generated always as identity primary key,
  competitor_id bigint references competitors(id) on delete cascade,
  kind          text not null,                  -- 'pricing'|'changelog'|'features'|'github_release'
  content_hash  text,
  raw           jsonb not null default '{}',
  captured_at   timestamptz not null default now()
);
create index if not exists idx_snap_comp on competitor_snapshots (competitor_id, kind, captured_at desc);

create table if not exists gap_findings (
  id            bigint generated always as identity primary key,
  competitor_id bigint references competitors(id) on delete set null,
  category      text,                           -- 'we_lack'|'we_lead'|'pricing_move'|'new_release'
  summary       text not null,
  evidence_url  text not null,                  -- ZORUNLU (halüsinasyon guard; yoksa kayıt yok)
  confidence    numeric,
  status        text not null default 'proposed' check (status in ('proposed','accepted','dismissed','shipped')),
  created_at    timestamptz not null default now()
);
