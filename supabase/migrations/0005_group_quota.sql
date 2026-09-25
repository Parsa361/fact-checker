-- Task 13 — سهمیه‌ی جدا برای گروه (per-chat quota)
--
-- چرا لازم است: بدون این، یک گروه ۵۰ نفره می‌تواند ۵۰×۵ = ۲۵۰ بررسی در روز از
-- GLOBAL_DAILY_API_BUDGET مشترک بردارد و عملاً بقیه‌ی کاربران را گرسنه بگذارد.
-- لایه‌ی ۴ (بودجه‌ی سراسری) فقط جلوی «کل سیستم» را می‌گیرد، نه جلوی یک گروه پرترافیک.
--
-- مدل سطل‌ها:
--   چت خصوصی → سطل کاربر (users.daily_checks_count، سقف DAILY_FREE_CHECK_LIMIT)
--   گروه       → سطل گروه  (group_chats.daily_checks_count، سقف GROUP_DAILY_CHECK_LIMIT)
--
-- این دو عمداً «جدا» شمرده می‌شوند: بررسی در گروه از سهمیه‌ی شخصی کاربر کم نمی‌کند
-- و برعکس. ولی لایه‌های ضد abuse (پنجره‌ی flood و هم‌زمانی هر کاربر = ۱) عمداً
-- per-user می‌مانند — هدفشان انصاف بین سطل‌ها نیست، جلوگیری از spam یک نفر است.
--
-- ⚠️ ترتیب قفل‌گیری به‌روزرسانی شد و در همه‌ی توابع باید همین باشد:
--       users → group_chats → daily_api_budget → jobs
--
-- ⚠️ یک لبه‌ی جدید که با گروه‌ها ایجاد می‌شود: fail_stuck_jobs_for_user کارِ
-- گیرکرده‌ی «همین کاربر» را آزاد می‌کند، ولی آن کار ممکن است در گروهِ *دیگری*
-- بوده باشد. یعنی برخلاف users (که همیشه همان یک ردیف است)، اینجا یک تراکنش
-- می‌تواند دو ردیف متفاوت group_chats را قفل کند — و دو تراکنش همزمان با
-- گروه‌های متقاطع در جهت مخالف قفل می‌گیرند و deadlock می‌شود. راه‌حل:
-- پیش‌قفل هر دو ردیف با ترتیب قطعی (صعودی بر اساس chat_id) قبل از هر کار دیگر.

-- ═══════════════════════════════════════════════════════════════════
-- ۱) جدول گروه‌ها
-- ═══════════════════════════════════════════════════════════════════

-- chat_id خودش کلید اصلی است (نه uuid): شناسه‌ی گروه تلگرام یکتا و پایدار است
-- و با کلید طبیعی، جدول jobs بدون join به سطل گروه وصل می‌شود.
create table if not exists public.group_chats (
  chat_id bigint primary key,
  -- فقط برای خوانا بودن پنل ادمین؛ هیچ منطقی به آن وابسته نیست.
  title text,
  daily_checks_count integer not null default 0,
  daily_checks_reset_at timestamptz not null
    default ((date_trunc('day', (now() at time zone 'Asia/Tehran')) + interval '1 day')
             at time zone 'Asia/Tehran'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.group_chats enable row level security;

drop trigger if exists group_chats_set_updated_at on public.group_chats;
create trigger group_chats_set_updated_at
  before update on public.group_chats
  for each row execute function public.set_updated_at();

-- null یعنی «این کار در چت خصوصی بود» — یعنی سطلش users است نه group_chats.
-- این ستون تنها چیزی است که به finalize_job_failure می‌گوید refund را به کدام
-- سطل برگرداند؛ بدون آن، شکست یک کار گروهی از سهمیه‌ی شخصی کاربر کم می‌کرد.
alter table public.jobs add column if not exists group_chat_id bigint;
-- همتای quota_reset_at برای سطل گروه. گاردِ refund تساوی دقیق timestamp است
-- (نه حساب تاریخ)، دقیقاً به همان دلیلی که در 0002 برای کاربر توضیح داده شد:
-- اگر کار قبل از نیمه‌شب ساخته شود و بعدش شکست بخورد، نباید از سهمیه‌ی روز
-- *جدید* گروه کم شود.
alter table public.jobs add column if not exists group_reset_at timestamptz;

-- ═══════════════════════════════════════════════════════════════════
-- ۲) رزرو اتمیک — نسخه‌ی آگاه به گروه
-- ═══════════════════════════════════════════════════════════════════
--
-- p_is_group صریح پاس داده می‌شود و از روی علامت chat_id حدس زده نمی‌شود.
-- (شناسه‌ی گروه در تلگرام منفی است، ولی تکیه به آن یعنی یک invariant نانوشته‌ی
-- پلتفرم را وسط منطق سهمیه قایم کنیم.) Node خودش ctx.chat.type را دارد.
--
-- ⚠️ DROP صریح لازم است و «create or replace» به‌تنهایی کافی نیست: امضای تابع در
-- Postgres شامل نوع پارامترهاست، پس افزودن سه پارامتر جدید یک overload *دوم*
-- می‌سازد و نسخه‌ی قدیمی سر جایش می‌ماند. نتیجه‌اش بدترین حالت ممکن بود — یک
-- فراخوانی بدون پارامترهای جدید بی‌صدا به نسخه‌ی قدیمی (بدون سهمیه‌ی گروه)
-- می‌رفت، یا PostgREST خطای «function is not unique» می‌داد.
drop function if exists public.reserve_check_slot(
  bigint, text, bigint, bigint, text, integer, integer,
  integer, interval, integer, text, timestamptz
);

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
  p_now timestamptz default now(),   -- فقط برای تست؛ production هرگز پاس نمی‌دهد
  p_is_group boolean default false,
  p_group_limit integer default 20,
  p_chat_title text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reset_at timestamptz;
  v_day date;
  v_user public.users%rowtype;
  v_group public.group_chats%rowtype;
  v_active_id uuid;
  v_dup boolean;
  v_used integer;
  v_job_id uuid;
  v_reaped jsonb;
  -- سطلی که این درخواست از آن مصرف می‌کند. برای گروه پر می‌شود، برای خصوصی null.
  v_group_chat_id bigint := case when p_is_group then p_chat_id else null end;
  v_quota_used integer;
  v_quota_limit integer;
  v_quota_reset_at timestamptz;
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

  -- ۲) پیش‌قفل ردیف‌های group_chats با ترتیب قطعی (صعودی بر اساس chat_id).
  --    مجموعه = گروه فعلی + گروهِ کارِ گیرکرده‌ی همین کاربر (اگر در گروه دیگری
  --    باشد). هر دو مسیرِ بعدی (upsert گروه فعلی، و refund داخل reap) روی
  --    همین ردیف‌ها قفل می‌خواهند؛ چون اینجا مرتب‌شده گرفته شده‌اند، دو تراکنش
  --    همزمان نمی‌توانند در جهت مخالف قفل بگیرند.
  --
  --    نکته: ردیف گروهِ کارِ گیرکرده همیشه از قبل وجود دارد (هنگام رزرو همان کار
  --    ساخته شده)، پس FOR UPDATE واقعاً قفلش می‌کند. فقط گروه فعلی ممکن است
  --    تازه باشد که در گام ۳ ساخته می‌شود.
  perform 1
    from public.group_chats g
   where g.chat_id in (
     select c from unnest(array[
       v_group_chat_id,
       (select j.group_chat_id
          from public.jobs j
         where j.user_id = v_user.id
           and j.status in ('reserved', 'pending', 'processing')
           and j.created_at < p_now - p_stuck_after
           and j.group_chat_id is not null
         limit 1)
     ]) as c
     where c is not null
   )
   order by g.chat_id
   for update;

  -- ۳) ساخت/قفل ردیف گروه + rollover پنجره‌ی روزانه‌اش.
  --    همان الگوی users: upsert قفل می‌گیرد، بعد بررسی و مصرف روی ردیف قفل‌شده
  --    انجام می‌شود — پس بین «خواندن» و «نوشتن» هیچ رقابتی ممکن نیست.
  if p_is_group then
    insert into public.group_chats (chat_id, title, daily_checks_count, daily_checks_reset_at)
    values (p_chat_id, p_chat_title, 0, v_reset_at)
    on conflict (chat_id) do update
      set title = coalesce(excluded.title, public.group_chats.title)
    returning * into v_group;

    if v_group.daily_checks_reset_at <= p_now then
      update public.group_chats
         set daily_checks_count = 0, daily_checks_reset_at = v_reset_at
       where chat_id = p_chat_id
      returning * into v_group;
    end if;
  end if;

  -- ۴) rollover پنجره روزانه کاربر
  if v_user.daily_checks_reset_at <= p_now then
    update public.users
       set daily_checks_count = 0, daily_checks_reset_at = v_reset_at
     where id = v_user.id
    returning * into v_user;
  end if;

  -- ۵) تحویل تکراری webhook (یا دو بار کلیک کاربر روی همان پیام)
  select true into v_dup
    from public.jobs
   where user_id = v_user.id and source_message_id = p_source_message_id;
  if v_dup then
    return jsonb_build_object('allowed', false, 'reason', 'duplicate_delivery', 'reaped', '[]'::jsonb);
  end if;

  -- ۶) خودترمیمی: کارهای گیرکرده همین کاربر را آزاد کن. یعنی پیام «بعدی» خود
  --    کاربر قفل را باز می‌کند، بدون نیاز به دخالت اپراتور یا ری‌استارت.
  v_reaped := public.fail_stuck_jobs_for_user(v_user.id, p_now - p_stuck_after);

  -- ۷) هم‌زمانی هر کاربر = ۱ (per-user می‌ماند، حتی در گروه)
  select id into v_active_id
    from public.jobs
   where user_id = v_user.id and status in ('reserved', 'pending', 'processing')
   limit 1;
  if v_active_id is not null then
    return public.deny(v_user.id, p_telegram_id, 'in_flight', jsonb_build_object('reaped', v_reaped));
  end if;

  -- ۸) ضد flood (per-user می‌ماند) — از ردیف قفل‌شده خوانده می‌شود
  if v_user.last_enqueued_at is not null
     and v_user.last_enqueued_at > p_now - make_interval(secs => p_flood_seconds) then
    return public.deny(v_user.id, p_telegram_id, 'flood', jsonb_build_object(
      'retry_after_seconds',
        ceil(extract(epoch from
          (v_user.last_enqueued_at + make_interval(secs => p_flood_seconds)) - p_now))::int,
      'reaped', v_reaped));
  end if;

  -- ۹) سهمیه روزانه (لایه ۱) — از سطل مربوط به همین چت
  if p_is_group then
    if v_group.daily_checks_count >= p_group_limit then
      return public.deny(v_user.id, p_telegram_id, 'group_quota_exceeded', jsonb_build_object(
        'reset_at', v_group.daily_checks_reset_at, 'reaped', v_reaped));
    end if;
  else
    if v_user.daily_checks_count >= p_daily_limit then
      return public.deny(v_user.id, p_telegram_id, 'quota_exceeded', jsonb_build_object(
        'reset_at', v_user.daily_checks_reset_at, 'reaped', v_reaped));
    end if;
  end if;

  -- ۱۰) بودجه سراسری (لایه ۴) — تک‌دستور، بدون فاصله بین خواندن و نوشتن.
  --     قفل ردیف روز، تنها چیزی است که دو کاربرِ «متفاوت» را سریالی می‌کند؛
  --     قفل ردیف کاربر اینجا هیچ کمکی نمی‌کند.
  --     عمداً «آخرین» بررسی است تا درخواستی که به هر دلیل دیگری رد می‌شود، از
  --     بودجه مصرف نکند.
  insert into public.daily_api_budget as b (day, used_count)
  values (v_day, 1)
  on conflict (day) do update
     set used_count = b.used_count + 1, updated_at = p_now
   where b.used_count < p_budget_limit
  returning b.used_count into v_used;

  if not found then
    return public.deny(v_user.id, p_telegram_id, 'budget_exceeded', jsonb_build_object('reaped', v_reaped));
  end if;

  -- ۱۱) مصرف سهمیه از سطل درست + ثبت پنجره flood (که همیشه per-user است)
  update public.users
     set last_enqueued_at = p_now,
         daily_checks_count = daily_checks_count + (case when p_is_group then 0 else 1 end)
   where id = v_user.id
  returning daily_checks_count, daily_checks_reset_at
       into v_user.daily_checks_count, v_user.daily_checks_reset_at;

  if p_is_group then
    update public.group_chats
       set daily_checks_count = daily_checks_count + 1
     where chat_id = p_chat_id
    returning daily_checks_count, daily_checks_reset_at
         into v_group.daily_checks_count, v_group.daily_checks_reset_at;

    v_quota_used     := v_group.daily_checks_count;
    v_quota_limit    := p_group_limit;
    v_quota_reset_at := v_group.daily_checks_reset_at;
  else
    v_quota_used     := v_user.daily_checks_count;
    v_quota_limit    := p_daily_limit;
    v_quota_reset_at := v_user.daily_checks_reset_at;
  end if;

  -- ۱۲) ثبت job در حالت reserved — تا وقتی پیام «⏳» تأیید نشده claim‌شدنی نیست.
  insert into public.jobs (
    user_id, telegram_id, chat_id, source_message_id, claim_text,
    status, max_attempts, quota_reset_at, budget_day,
    group_chat_id, group_reset_at
  ) values (
    v_user.id, p_telegram_id, p_chat_id, p_source_message_id, p_claim_text,
    'reserved', p_max_attempts, v_user.daily_checks_reset_at, v_day,
    v_group_chat_id, case when p_is_group then v_group.daily_checks_reset_at end
  ) returning id into v_job_id;

  insert into public.rate_limit_events (user_id, telegram_id, event_type, window_key, metadata)
  values (v_user.id, p_telegram_id, 'allow',
          to_char(p_now at time zone p_timezone, 'YYYY-MM-DD'),
          jsonb_build_object('job_id', v_job_id, 'group_chat_id', v_group_chat_id));

  return jsonb_build_object(
    'allowed', true,
    'job_id', v_job_id,
    'quota_used', v_quota_used,
    'quota_limit', v_quota_limit,
    'reset_at', v_quota_reset_at,
    'reaped', v_reaped
  );

exception
  when unique_violation then
    -- backstop ایندکس یکتا. کل تراکنش (شامل افزایش بودجه و سهمیه) rollback می‌شود.
    return jsonb_build_object('allowed', false, 'reason', 'in_flight', 'reaped', '[]'::jsonb);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- ۳) refund آگاه به سطل
-- ═══════════════════════════════════════════════════════════════════

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
  -- ⚠️ ترتیب قفل: users → group_chats → jobs — دقیقاً همان ترتیبی که
  -- reserve_check_slot دارد. بدون این، دو تابع در جهت مخالف قفل می‌گیرند.
  perform 1 from public.users u
   where u.id = (select j.user_id from public.jobs j where j.id = p_job_id)
     for update;

  perform 1 from public.group_chats g
   where g.chat_id = (select j.group_chat_id from public.jobs j where j.id = p_job_id)
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

  -- refund به همان سطلی که مصرف شده بود، و فقط اگر پنجره‌ی روزانه هنوز همان
  -- پنجره‌ای باشد که رزرو رویش حساب شده بود. تساوی دقیق timestamp: اگر مرز روز
  -- عوض شده باشد مقدارها برابر نیستند، صفر ردیف آپدیت می‌شود و اشتباهاً از
  -- سهمیه‌ی روز جدید کم نمی‌کنیم.
  if v_job.group_chat_id is null then
    update public.users u
       set daily_checks_count = greatest(0, u.daily_checks_count - 1)
     where u.id = v_job.user_id
       and u.daily_checks_reset_at = v_job.quota_reset_at;
  else
    update public.group_chats g
       set daily_checks_count = greatest(0, g.daily_checks_count - 1)
     where g.chat_id = v_job.group_chat_id
       and g.daily_checks_reset_at = v_job.group_reset_at;
  end if;
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
