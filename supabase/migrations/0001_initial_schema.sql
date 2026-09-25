-- اسکیمای اولیه بر اساس docs/ARCHITECTURE.md بخش ۸
-- نکته امنیتی (docs/SECURITY.md بخش ۶): روی همه جدول‌ها RLS فعال است و هیچ policy
-- تعریف نشده؛ یعنی نقش‌های anon و authenticated هیچ دسترسی ندارند. بک‌اند ربات با
-- service_role کار می‌کند که RLS را دور می‌زند.

create extension if not exists vector with schema extensions;

-- ۱) کاربران
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null unique,
  username text,
  plan text not null default 'free',
  daily_checks_count integer not null default 0,
  daily_checks_reset_at timestamptz not null default date_trunc('day', now()) + interval '1 day',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ۲) بررسی‌ها
create table if not exists public.checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  telegram_message_id bigint,
  source_chat_id bigint,
  claim_text text not null,
  normalized_hash text not null,
  verdict_status text not null,
  confidence numeric(5,2) not null,
  sources jsonb not null default '[]'::jsonb,
  model_name text not null,
  stage1_decision text,
  latency_ms integer,
  estimated_cost_usd numeric(10,4),
  created_at timestamptz not null default now()
);

create index if not exists checks_user_id_created_at_idx
  on public.checks (user_id, created_at desc);
create index if not exists checks_normalized_hash_idx
  on public.checks (normalized_hash);

-- ۳) کش نتایج
create table if not exists public.cache_entries (
  id uuid primary key default gen_random_uuid(),
  normalized_hash text not null unique,
  claim_text text not null,
  embedding extensions.vector(768),
  result jsonb not null,
  source_fingerprint text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_accessed_at timestamptz,
  hit_count integer not null default 0
);

-- ایندکس embedding (ivfflat/hnsw) در Task 8 همراه با منطق cache اضافه می‌شود.
create index if not exists cache_entries_expires_at_idx
  on public.cache_entries (expires_at);

-- ۴) رویدادهای rate limit
create table if not exists public.rate_limit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  telegram_id bigint,
  event_type text not null,
  window_key text not null,
  counter integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_events_telegram_id_window_key_idx
  on public.rate_limit_events (telegram_id, window_key);
create index if not exists rate_limit_events_created_at_idx
  on public.rate_limit_events (created_at desc);

-- ۵) لاگ‌های audit
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null,
  actor_id text,
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);
create index if not exists audit_logs_actor_id_idx
  on public.audit_logs (actor_id);

-- به‌روزرسانی خودکار users.updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
  before update on public.users
  for each row
  execute function public.set_updated_at();

-- فعال‌سازی RLS روی همه جدول‌ها (بدون policy — فقط service_role دسترسی دارد)
alter table public.users enable row level security;
alter table public.checks enable row level security;
alter table public.cache_entries enable row level security;
alter table public.rate_limit_events enable row level security;
alter table public.audit_logs enable row level security;
