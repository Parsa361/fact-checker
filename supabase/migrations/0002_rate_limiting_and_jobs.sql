-- Task 9 — محدودیت نرخ چندلایه + صف کار پایدار
-- بر اساس docs/RATE-LIMITING.md (چهار لایه) و docs/ARCHITECTURE.md §۵ (پردازش async)
--
-- چرا همه‌چیز داخل توابع plpgsql است و نه در کد Node؟
-- در پروژه فقط @supabase/supabase-js نصب است (درایور pg نداریم). هر فراخوانی
-- supabase-js یک درخواست HTTP مستقل به PostgREST است، پس نمی‌شود از سمت Node یک
-- تراکنش چندمرحله‌ای باز کرد. اما هر فراخوانی .rpc() خودش دقیقاً یک تراکنش است —
-- و همین خاصیت چیزی است که برای اتمیک بودن رزرو سهمیه/بودجه لازم داریم.
--
-- ⚠️ ترتیب قفل‌گیری در همه توابع باید ثابت باشد: users → daily_api_budget → jobs
-- در غیر این صورت deadlock رخ می‌دهد (مثلاً کاربری دقیقاً همان لحظه‌ای پیام بدهد که
-- job قبلی‌اش در حال fail شدن است). Postgres یکی از دو طرف را با خطای 40P01 قطع
-- می‌کند که به‌صورت خطای ۵۰۰ از PostgREST بیرون می‌آید و مسیر fail-closed ما
-- کاربر بی‌گناه را رد می‌کند.

-- ═══════════════════════════════════════════════════════════════════
-- ۱) جدول‌ها
-- ═══════════════════════════════════════════════════════════════════

-- شمارنده بودجه سراسری روزانه (لایه ۴ در RATE-LIMITING.md).
-- واحد این شمارنده «تعداد بررسی پذیرفته‌شده» است، نه «تعداد تماس API».
-- با این تعریف، refund کردنش بی‌معنی است (توضیح در finalize_job_failure).
create table if not exists public.daily_api_budget (
  day date primary key,
  used_count integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.daily_api_budget enable row level security;

-- پنجره ضد flood (لایه ۲) روی همین ردیف قفل‌شده کاربر می‌نشیند.
-- عمداً از count() روی rate_limit_events استفاده نمی‌کنیم: آن کوئری هیچ قفلی
-- نمی‌گیرد و دو درخواست همزمان می‌توانند هر دو از آن رد شوند.
alter table public.users add column if not exists last_enqueued_at timestamptz;

-- اصلاح باگ نهفته: default این ستون نیمه‌شب UTC را حساب می‌کرد، در حالی که
-- محصول نیمه‌شب تهران را می‌خواهد (TZ=Asia/Tehran). توابع زیر مرز تهران را
-- صریحاً محاسبه می‌کنند و هرگز به این default تکیه نمی‌کنند، ولی اصلاحش
-- می‌کنیم تا ردیف‌هایی که از مسیر دیگری insert شوند هم درست باشند.
alter table public.users alter column daily_checks_reset_at
  set default ((date_trunc('day', (now() at time zone 'Asia/Tehran')) + interval '1 day')
               at time zone 'Asia/Tehran');

-- صف کار پایدار. دلیل وجودش: اگر پروسه Node کرش کند یا deploy شود، صفی که فقط
-- در حافظه باشد همه کارهای در جریان را بی‌صدا گم می‌کند و کاربر تا ابد روی
-- «⏳ در حال بررسی...» می‌ماند.
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- telegram_id و chat_id عمداً denormalize شده‌اند تا worker برای پاسخ دادن
  -- نیازی به join با users نداشته باشد.
  telegram_id bigint not null,
  chat_id bigint not null,
  -- کلید طبیعی idempotency: message_id تلگرام در هر چت صعودی است و هرگز
  -- بازاستفاده نمی‌شود. با این کلید، تحویل مجدد webhook یک no-op بی‌صداست.
  source_message_id bigint not null,
  -- تا وقتی پیام «⏳» تأیید نشده null است؛ به همین دلیل حالت reserved وجود دارد.
  status_message_id bigint,
  claim_text text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'pending', 'processing', 'done', 'failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 2,
  -- دقیقاً همان مرز پنجره‌ای که این رزرو رویش حساب شده. برای گارد refund از
  -- تساوی دقیق timestamp استفاده می‌کنیم نه حساب تاریخ (توضیح در finalize_job_failure).
  quota_reset_at timestamptz not null,
  budget_day date not null,
  -- متن رندرشده «قبل از» تحویل ذخیره می‌شود تا اگر تحویل به تلگرام شکست خورد،
  -- تلاش مجدد کل pipeline جمنای را دوباره اجرا (و هزینه) نکند.
  result_text text,
  result_parse_mode text,
  last_error text,
  refunded_at timestamptz,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.jobs enable row level security;

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- هم‌زمانی هر کاربر = ۱، به‌صورت یک invariant دیتابیسی نه فقط منطق برنامه.
-- این ایندکس backstop تابع reserve_check_slot است.
create unique index if not exists jobs_one_active_per_user_idx
  on public.jobs (user_id)
  where status in ('reserved', 'pending', 'processing');

-- برای جاروی بازیابی هنگام بالا آمدن پروسه.
create index if not exists jobs_active_created_at_idx
  on public.jobs (created_at)
  where status in ('reserved', 'pending', 'processing');

-- تشخیص تحویل تکراری webhook.
create unique index if not exists jobs_user_source_message_idx
  on public.jobs (user_id, source_message_id);

-- ═══════════════════════════════════════════════════════════════════
-- ۲) توابع کمکی
-- ═══════════════════════════════════════════════════════════════════

-- هر رد کردن هم در audit log ثبت می‌شود (برای Task 10) و هم به‌صورت jsonb
-- برمی‌گردد. جدا کردنش باعث می‌شود تابع اصلی خواناتر بماند.
create or replace function public.deny(
  p_user_id uuid,
  p_telegram_id bigint,
  p_reason text,
  p_extra jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.rate_limit_events (user_id, telegram_id, event_type, window_key, metadata)
  values (p_user_id, p_telegram_id, p_reason, to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS'), p_extra);

  return jsonb_build_object('allowed', false, 'reason', p_reason) || p_extra;
end;
$$;

-- کارهای گیرکرده یک کاربر را terminal و refund می‌کند.
-- بدون این، یک job که به هر دلیلی در حالت processing گیر کند، به‌خاطر ایندکس
-- یکتای بالا کاربر را برای همیشه از ربات قفل می‌کند.
create or replace function public.fail_stuck_jobs_for_user(
  p_user_id uuid,
  p_cutoff timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job record;
  v_reaped jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  for v_job in
    select id from public.jobs
     where user_id = p_user_id
       and status in ('reserved', 'pending', 'processing')
       and created_at < p_cutoff
  loop
    v_result := public.finalize_job_failure(v_job.id, 'job stuck; reaped by rate limiter');
    if (v_result ->> 'finalized')::boolean then
      v_reaped := v_reaped || jsonb_build_array(
        jsonb_build_object(
          'job_id', v_result ->> 'job_id',
          'chat_id', (v_result ->> 'chat_id')::bigint,
          'status_message_id', (v_result ->> 'status_message_id')::bigint
        )
      );
    end if;
  end loop;

  return v_reaped;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- ۳) رزرو اتمیک — هسته Task 9
-- ═══════════════════════════════════════════════════════════════════
--
-- کل این تابع یک تراکنش است؛ هیچ حالت نیمه‌کاره‌ای داخلش ممکن نیست.
-- ترتیب بررسی‌ها عمدی است: بودجه سراسری «آخر» افزایش می‌یابد تا درخواستی که
-- به هر دلیل دیگری رد می‌شود، از بودجه مصرف نکند.
create or replace function public.reserve_check_slot(
  p_telegram_id bigint,
  p_username text,
  p_chat_id bigint,
  p_source_message_id bigint,
  p_claim_text text,
  p_daily_limit integer,
  p_budget_limit integer,
  p_flood_seconds integer default 30,
  p_stuck_after interval default interval '10 minutes',
  p_max_attempts integer default 2,
  p_timezone text default 'Asia/Tehran',
  p_now timestamptz default now()   -- فقط برای تست؛ production هرگز پاس نمی‌دهد
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reset_at timestamptz;
  v_day date;
  v_user public.users%rowtype;
  v_active_id uuid;
  v_dup boolean;
  v_used integer;
  v_job_id uuid;
  v_reaped jsonb;
begin
  -- کلید کشتن اضطراری: با GLOBAL_DAILY_API_BUDGET=0 می‌شود بدون deploy همه‌چیز
  -- را متوقف کرد.
  if p_budget_limit <= 0 then
    return public.deny(null, p_telegram_id, 'budget_exceeded');
  end if;

  -- مرز روز به وقت تهران — هرگز به default ستون تکیه نکن.
  v_reset_at := (date_trunc('day', (p_now at time zone p_timezone)) + interval '1 day')
                at time zone p_timezone;
  v_day := (p_now at time zone p_timezone)::date;

  -- ۱) قفل ردیف کاربر. این upsert نقش mutex را دارد: تا پایان تراکنش، هیچ
  --    درخواست همزمان دیگری از همین کاربر نمی‌تواند جلو برود.
  --    ⚠️ این را با SELECT ساده + UPDATE جدا جایگزین نکنید — قفل از بین می‌رود.
  insert into public.users (telegram_id, username, daily_checks_count, daily_checks_reset_at)
  values (p_telegram_id, p_username, 0, v_reset_at)
  on conflict (telegram_id) do update
    set username = coalesce(excluded.username, public.users.username)
  returning * into v_user;

  -- ۲) rollover پنجره روزانه
  if v_user.daily_checks_reset_at <= p_now then
    update public.users
       set daily_checks_count = 0, daily_checks_reset_at = v_reset_at
     where id = v_user.id
    returning * into v_user;
  end if;

  -- ۳) تحویل تکراری webhook (یا دو بار کلیک کاربر روی همان پیام)
  select true into v_dup
    from public.jobs
   where user_id = v_user.id and source_message_id = p_source_message_id;
  if v_dup then
    return jsonb_build_object('allowed', false, 'reason', 'duplicate_delivery', 'reaped', '[]'::jsonb);
  end if;

  -- ۴) خودترمیمی: کارهای گیرکرده همین کاربر را آزاد کن. یعنی پیام «بعدی» خود
  --    کاربر قفل را باز می‌کند، بدون نیاز به دخالت اپراتور یا ری‌استارت.
  v_reaped := public.fail_stuck_jobs_for_user(v_user.id, p_now - p_stuck_after);

  -- ۵) هم‌زمانی هر کاربر = ۱
  select id into v_active_id
    from public.jobs
   where user_id = v_user.id and status in ('reserved', 'pending', 'processing')
   limit 1;
  if v_active_id is not null then
    return public.deny(v_user.id, p_telegram_id, 'in_flight', jsonb_build_object('reaped', v_reaped));
  end if;

  -- ۶) ضد flood — از ردیف قفل‌شده خوانده می‌شود
  if v_user.last_enqueued_at is not null
     and v_user.last_enqueued_at > p_now - make_interval(secs => p_flood_seconds) then
    return public.deny(v_user.id, p_telegram_id, 'flood', jsonb_build_object(
      'retry_after_seconds',
        ceil(extract(epoch from
          (v_user.last_enqueued_at + make_interval(secs => p_flood_seconds)) - p_now))::int,
      'reaped', v_reaped));
  end if;

  -- ۷) سهمیه روزانه (لایه ۱)
  if v_user.daily_checks_count >= p_daily_limit then
    return public.deny(v_user.id, p_telegram_id, 'quota_exceeded', jsonb_build_object(
      'reset_at', v_user.daily_checks_reset_at, 'reaped', v_reaped));
  end if;

  -- ۸) بودجه سراسری (لایه ۴) — تک‌دستور، بدون فاصله بین خواندن و نوشتن.
  --    قفل ردیف روز، تنها چیزی است که دو کاربرِ «متفاوت» را سریالی می‌کند؛
  --    قفل ردیف کاربر اینجا هیچ کمکی نمی‌کند.
  insert into public.daily_api_budget as b (day, used_count)
  values (v_day, 1)
  on conflict (day) do update
     set used_count = b.used_count + 1, updated_at = p_now
   where b.used_count < p_budget_limit
  returning b.used_count into v_used;

  if not found then
    return public.deny(v_user.id, p_telegram_id, 'budget_exceeded', jsonb_build_object('reaped', v_reaped));
  end if;

  -- ۹) مصرف سهمیه + ثبت پنجره flood
  update public.users
     set daily_checks_count = daily_checks_count + 1, last_enqueued_at = p_now
   where id = v_user.id
  returning daily_checks_count, daily_checks_reset_at
       into v_user.daily_checks_count, v_user.daily_checks_reset_at;

  -- ۱۰) ثبت job در حالت reserved — تا وقتی پیام «⏳» تأیید نشده claim‌شدنی نیست.
  insert into public.jobs (
    user_id, telegram_id, chat_id, source_message_id, claim_text,
    status, max_attempts, quota_reset_at, budget_day
  ) values (
    v_user.id, p_telegram_id, p_chat_id, p_source_message_id, p_claim_text,
    'reserved', p_max_attempts, v_user.daily_checks_reset_at, v_day
  ) returning id into v_job_id;

  insert into public.rate_limit_events (user_id, telegram_id, event_type, window_key, metadata)
  values (v_user.id, p_telegram_id, 'allow',
          to_char(p_now at time zone p_timezone, 'YYYY-MM-DD'),
          jsonb_build_object('job_id', v_job_id));

  return jsonb_build_object(
    'allowed', true,
    'job_id', v_job_id,
    'quota_used', v_user.daily_checks_count,
    'quota_limit', p_daily_limit,
    'reset_at', v_user.daily_checks_reset_at,
    'reaped', v_reaped
  );

exception
  when unique_violation then
    -- backstop ایندکس یکتا. کل تراکنش (شامل افزایش بودجه و سهمیه) rollback می‌شود.
    return jsonb_build_object('allowed', false, 'reason', 'in_flight', 'reaped', '[]'::jsonb);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- ۴) چرخه عمر job
-- ═══════════════════════════════════════════════════════════════════

-- reserved → pending. تا این لحظه job قابل برداشت نیست، و همین است که رقابت
-- «worker زودتر از نوشتن status_message_id تمام شود» را از اساس ممکن نمی‌کند.
create or replace function public.mark_job_ready(
  p_job_id uuid,
  p_status_message_id bigint
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job jsonb;
begin
  update public.jobs j
     set status_message_id = p_status_message_id, status = 'pending'
   where j.id = p_job_id and j.status = 'reserved'
  returning to_jsonb(j) into v_job;

  return coalesce(v_job, jsonb_build_object('error', 'job not in reserved state'));
end;
$$;

-- CAS برای pending → processing.
-- چون id از قبل معلوم است، به FOR UPDATE SKIP LOCKED نیازی نیست: یک UPDATE
-- تک‌دستوره خودش اتمیک است و درخواست همزمان دوم صفر ردیف می‌بیند.
--
-- ⚠️ attempts هنگام «برداشتن» زیاد می‌شود نه هنگام «شکست». دلیلش: پروسه‌ای که
-- وسط کار kill شود هم باید یک تلاش مصرف کند، وگرنه job سمی‌ای که پروسه را
-- می‌کشد در هر بالا آمدن دوباره زنده می‌شود و بی‌نهایت تکرار می‌کند.
create or replace function public.claim_job(p_job_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job jsonb;
begin
  update public.jobs j
     set status = 'processing', attempts = j.attempts + 1, claimed_at = now()
   where j.id = p_job_id and j.status = 'pending'
  returning to_jsonb(j) into v_job;

  return v_job;  -- null یعنی یکی دیگر برش داشته یا terminal شده
end;
$$;

-- ذخیره نتیجه رندرشده «قبل از» تلاش برای تحویل.
create or replace function public.save_job_result(
  p_job_id uuid,
  p_result_text text,
  p_parse_mode text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.jobs
     set result_text = p_result_text, result_parse_mode = p_parse_mode
   where id = p_job_id;

  return jsonb_build_object('saved', found);
end;
$$;

create or replace function public.complete_job(p_job_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update public.jobs
     set status = 'done', finished_at = now()
   where id = p_job_id and status = 'processing';
  get diagnostics v_rows = row_count;

  return jsonb_build_object('completed', v_rows > 0);
end;
$$;

-- terminal کردن + refund سهمیه. تنها جایی که refund انجام می‌شود.
create or replace function public.finalize_job_failure(
  p_job_id uuid,
  p_error text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_refunded boolean := false;
begin
  -- ⚠️ ترتیب قفل: اول users بعد jobs — دقیقاً همان ترتیبی که reserve_check_slot
  -- دارد. بدون این خط، این دو تابع در جهت مخالف قفل می‌گیرند و deadlock می‌شود.
  perform 1 from public.users u
   where u.id = (select j.user_id from public.jobs j where j.id = p_job_id)
     for update;

  -- CAS: فقط اگر واقعاً از حالت غیرترمینال به failed رفتیم، refund مجاز است.
  -- همین گارد جلوی refund دوتایی را می‌گیرد (نه فیلد refunded_at که صرفاً audit است).
  update public.jobs j
     set status = 'failed',
         last_error = left(coalesce(p_error, ''), 2000),
         finished_at = now()
   where j.id = p_job_id and j.status in ('reserved', 'pending', 'processing')
  returning j.* into v_job;

  if not found then
    return jsonb_build_object('finalized', false);
  end if;

  -- refund فقط اگر پنجره روزانه همان پنجره‌ای باشد که رزرو رویش حساب شده بود.
  -- تساوی دقیق timestamp: اگر مرز روز عوض شده باشد، مقدارها برابر نیستند،
  -- صفر ردیف آپدیت می‌شود و اشتباهاً از سهمیه روز جدید کم نمی‌کنیم.
  update public.users u
     set daily_checks_count = greatest(0, u.daily_checks_count - 1)
   where u.id = v_job.user_id
     and u.daily_checks_reset_at = v_job.quota_reset_at;
  v_refunded := found;

  if v_refunded then
    update public.jobs set refunded_at = now() where id = p_job_id;
  end if;

  -- daily_api_budget عمداً refund نمی‌شود: job شکست‌خورده به احتمال زیاد
  -- تماس‌های واقعی جمنای را مصرف کرده. برگرداندنش یعنی کم‌شماری سیستماتیک
  -- مصرف واقعی، که هدف این محافظ را از بین می‌برد.

  return jsonb_build_object(
    'finalized', true,
    'refunded', v_refunded,
    'job_id', v_job.id,
    'chat_id', v_job.chat_id,
    'status_message_id', v_job.status_message_id
  );
end;
$$;

-- تصمیم retry: اگر terminal یا تلاش‌ها تمام شده → finalize، وگرنه برگردان به pending.
create or replace function public.fail_job(
  p_job_id uuid,
  p_error text,
  p_terminal boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs where id = p_job_id;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;

  if p_terminal or v_job.attempts >= v_job.max_attempts then
    return public.finalize_job_failure(p_job_id, p_error) || jsonb_build_object('status', 'failed');
  end if;

  update public.jobs
     set status = 'pending', claimed_at = null, last_error = left(coalesce(p_error, ''), 2000)
   where id = p_job_id and status = 'processing';

  return jsonb_build_object('status', 'pending', 'attempts', v_job.attempts);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- ۵) بازیابی هنگام بالا آمدن پروسه
-- ═══════════════════════════════════════════════════════════════════
--
-- p_claimed_before مرز کهنگی است. با تک‌پروسه بودن، هنگام boot مقدار now()
-- پاس داده می‌شود یعنی «همه چیز کهنه است» — که درست است چون پروسه دیگری وجود ندارد.
--
-- اگر روزی چند instance اجرا شود: instance دوم کارهای «زنده» instance اول را
-- دوباره صف می‌کند → مصرف دوباره جمنای و ویرایش تکراری پیام. چیزی خراب نمی‌شود
-- ولی هزینه دارد. راه‌حل آن روز: heartbeat + owner_id + claim_next_job با
-- FOR UPDATE SKIP LOCKED. هر سه additive هستند و نیازی به بازطراحی ندارند.
create or replace function public.requeue_stale_jobs(
  p_claimed_before timestamptz,
  p_max_age interval
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_abandon jsonb;
  v_requeued jsonb;
begin
  -- رها کردن: هر job در حالت reserved (هرگز به کاربر «⏳» تأیید نشده، پس
  -- status_message_id نداریم که ویرایشش کنیم)، یا خیلی قدیمی، یا تلاش‌هایش تمام.
  select coalesce(jsonb_agg(jsonb_build_object('job_id', id)), '[]'::jsonb)
    into v_abandon
    from public.jobs
   where status in ('reserved', 'pending', 'processing')
     and (status = 'reserved'
          or created_at < now() - p_max_age
          or attempts >= max_attempts);

  -- صف مجدد: باقی کارهای غیرترمینال.
  -- ⚠️ فهرست دقیقاً از RETURNING همین UPDATE ساخته می‌شود، نه از یک SELECT
  -- جداگانه: کوئری جدا کارهایی را که در فهرست رها‌شدن هستند (مثلاً pending با
  -- attempts تمام‌شده) هم برمی‌داشت و آن‌ها همزمان هم رها و هم dispatch می‌شدند.
  with updated as (
    update public.jobs
       set status = 'pending', claimed_at = null
     where status in ('pending', 'processing')
       and created_at >= now() - p_max_age
       and attempts < max_attempts
       and (claimed_at is null or claimed_at < p_claimed_before)
    returning id
  )
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_requeued from updated;

  return jsonb_build_object('abandon', v_abandon, 'requeued', v_requeued);
end;
$$;

-- نگه‌داری: jobهای terminal قدیمی پاک می‌شوند. یک بار هنگام boot صدا زده
-- می‌شود، پس نیازی به cron نیست.
create or replace function public.cleanup_old_jobs(p_older_than interval default interval '7 days')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.jobs
   where status in ('done', 'failed') and finished_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('deleted', v_deleted);
end;
$$;
