-- Task 13 — فقط ادمین می‌تواند ربات را به گروه اضافه کند
--
-- بدون این، هر کسی می‌تواند ربات را به هر گروهی اضافه کند و از سهمیه‌ی رایگان
-- (که هزینه‌ی واقعی Gemini/Tavily دارد) مصرف کند. مکانیزم مشابه چک ADMIN_TELEGRAM_IDS
-- در دستور /stats است، ولی روی رویداد «عضویت ربات در چت» اجرا می‌شود نه هر پیام:
-- وقتی Node تشخیص می‌دهد ربات به یک گروه اضافه شده (my_chat_member)، اگر کسی که
-- اضافه کرده ادمین نباشد، ربات همان لحظه با leaveChat گروه را ترک می‌کند —
-- یعنی حتی یک /check هم فرصت اجرا شدن پیدا نمی‌کند.
--
-- ⚠️ این ستون‌ها «توضیح‌دهنده»اند، نه دروازه‌ی اصلی: تصمیم واقعیِ ماندن/ترک‌کردن
-- در Node گرفته می‌شود (چون فقط Node به my_chat_member دسترسی دارد). authorized
-- اینجا فقط دفاع لایه‌ی دوم است — برای گروهی که به هر دلیلی (رقابت race، خطای
-- شبکه هنگام leaveChat) با وجود عدم اجازه هنوز عضو مانده، reserve_check_slot
-- هم مستقل رد می‌کند.

alter table public.group_chats add column if not exists authorized boolean not null default false;
alter table public.group_chats add column if not exists authorized_by bigint;

-- grandfather: گروه‌هایی که پیش از این migration در دیتابیس ثبت شده‌اند (تست‌های
-- Task 13 روی همین گروه) از قبل مورد اعتماد بودند — این migration نباید آن‌ها را
-- یک‌شبه غیرفعال کند. هر گروه از این پس اضافه شود، از دروازه‌ی my_chat_member رد
-- می‌شود.
update public.group_chats set authorized = true where authorized = false;

-- ═══════════════════════════════════════════════════════════════════
-- رزرو اتمیک — رد کردن گروه غیرمجاز قبل از هر مصرف سهمیه
-- ═══════════════════════════════════════════════════════════════════
--
-- امضای تابع نسبت به migration قبلی عوض نشده (همان پارامترها)، پس برخلاف
-- 0005_group_quota.sql اینجا DROP صریح لازم نیست — create or replace کافی است.
-- (یادآوری قاعده‌ی همان migration: هر وقت امضا عوض شود، چون Postgres امضا را
-- بخشی از هویت تابع می‌داند، create or replace به‌تنهایی overload دوم می‌سازد
-- و DROP صریح ضروری می‌شود.)
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
  v_group_chat_id bigint := case when p_is_group then p_chat_id else null end;
  v_quota_used integer;
  v_quota_limit integer;
  v_quota_reset_at timestamptz;
begin
  if p_budget_limit <= 0 then
    return public.deny(null, p_telegram_id, 'budget_exceeded');
  end if;

  v_reset_at := (date_trunc('day', (p_now at time zone p_timezone)) + interval '1 day')
                at time zone p_timezone;
  v_day := (p_now at time zone p_timezone)::date;

  insert into public.users (telegram_id, username, daily_checks_count, daily_checks_reset_at)
  values (p_telegram_id, p_username, 0, v_reset_at)
  on conflict (telegram_id) do update
    set username = coalesce(excluded.username, public.users.username)
  returning * into v_user;

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

  if p_is_group then
    -- ⚠️ دروازه‌ی مجوز: قبل از هر رزرو سهمیه چک می‌شود. اگر گروه هنوز ردیف
    -- نداشته باشد (یعنی هرگز از my_chat_member رد نشده) v_group.authorized پیش‌فرض
    -- false می‌ماند و رد می‌شود — fail-closed، مطابق docs/TECH-SPEC.md §۸.
    select * into v_group from public.group_chats where chat_id = p_chat_id;
    if not found or not v_group.authorized then
      return public.deny(v_user.id, p_telegram_id, 'group_not_authorized');
    end if;

    if v_group.daily_checks_reset_at <= p_now then
      update public.group_chats
         set daily_checks_count = 0, daily_checks_reset_at = v_reset_at
       where chat_id = p_chat_id
      returning * into v_group;
    end if;

    if v_group.title is distinct from p_chat_title and p_chat_title is not null then
      update public.group_chats set title = p_chat_title where chat_id = p_chat_id;
    end if;
  end if;

  if v_user.daily_checks_reset_at <= p_now then
    update public.users
       set daily_checks_count = 0, daily_checks_reset_at = v_reset_at
     where id = v_user.id
    returning * into v_user;
  end if;

  select true into v_dup
    from public.jobs
   where user_id = v_user.id and source_message_id = p_source_message_id;
  if v_dup then
    return jsonb_build_object('allowed', false, 'reason', 'duplicate_delivery', 'reaped', '[]'::jsonb);
  end if;

  v_reaped := public.fail_stuck_jobs_for_user(v_user.id, p_now - p_stuck_after);

  select id into v_active_id
    from public.jobs
   where user_id = v_user.id and status in ('reserved', 'pending', 'processing')
   limit 1;
  if v_active_id is not null then
    return public.deny(v_user.id, p_telegram_id, 'in_flight', jsonb_build_object('reaped', v_reaped));
  end if;

  if v_user.last_enqueued_at is not null
     and v_user.last_enqueued_at > p_now - make_interval(secs => p_flood_seconds) then
    return public.deny(v_user.id, p_telegram_id, 'flood', jsonb_build_object(
      'retry_after_seconds',
        ceil(extract(epoch from
          (v_user.last_enqueued_at + make_interval(secs => p_flood_seconds)) - p_now))::int,
      'reaped', v_reaped));
  end if;

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

  insert into public.daily_api_budget as b (day, used_count)
  values (v_day, 1)
  on conflict (day) do update
     set used_count = b.used_count + 1, updated_at = p_now
   where b.used_count < p_budget_limit
  returning b.used_count into v_used;

  if not found then
    return public.deny(v_user.id, p_telegram_id, 'budget_exceeded', jsonb_build_object('reaped', v_reaped));
  end if;

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
    return jsonb_build_object('allowed', false, 'reason', 'in_flight', 'reaped', '[]'::jsonb);
end;
$$;
