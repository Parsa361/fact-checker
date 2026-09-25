-- Task 10 — متریک‌های پایه، audit و نگه‌داری
-- بر اساس چک‌لیست docs/TASKS.md بخش ۱۰ و docs/SECURITY.md §۸
--
-- جدول checks از migration 0001 وجود دارد ولی تا امروز هیچ‌وقت پر نشده بود.
-- از این Task به بعد، «حافظه‌ی بلندمدت» متریک‌هاست: جدول jobs هر ۷ روز پاک
-- می‌شود (cleanup_old_jobs)، پس نمی‌تواند تاریخچه نگه دارد.

-- ═══════════════════════════════════════════════════════════════════
-- ۱) ستون‌های جدید روی checks
-- ═══════════════════════════════════════════════════════════════════
--
-- «add column if not exists» یعنی اگر ستون از قبل بود کاری نکن — به همین
-- خاطر اجرای دوباره‌ی این فایل بی‌خطر است.

-- شناسه‌ی job‌ای که این بررسی از آن آمده. عمداً foreign key نیست: ردیف job بعد
-- از ۷ روز پاک می‌شود و اگر FK می‌گذاشتیم یا این ردیف هم پاک می‌شد یا حذف job
-- با خطا متوقف می‌شد. اینجا فقط «یک عدد برای ردیابی» است.
alter table public.checks add column if not exists job_id uuid;

-- آیا جواب از کش آمد؟ کل متریک «نرخ cache hit» روی همین یک ستون بنا می‌شود.
alter table public.checks add column if not exists cache_hit boolean not null default false;

-- زمان خالص مدل (بدون انتظار در صف). latency_ms کل انتظار کاربر است.
alter table public.checks add column if not exists pipeline_ms integer;

-- ایندکس «یکتا» یعنی Postgres اجازه نمی‌دهد دو ردیف مقدار یکسان داشته باشند.
-- اینجا تضمین می‌کند حتی اگر کد اشتباهاً دو بار برای یک job گزارش بدهد، فقط
-- یک ردیف ثبت شود. شرط «where job_id is not null» لازم است چون ردیف‌های
-- احتمالیِ بدون job (مثلاً درج دستی هنگام تست) نباید به هم گیر کنند.
create unique index if not exists checks_job_id_uidx
  on public.checks (job_id) where job_id is not null;

-- برای همه‌ی view‌های زیر که «بازه‌ی زمانی اخیر» را فیلتر می‌کنند.
create index if not exists checks_created_at_idx
  on public.checks (created_at desc);

-- ═══════════════════════════════════════════════════════════════════
-- ۲) record_check — ثبت یک بررسی تمام‌شده در تاریخچه
-- ═══════════════════════════════════════════════════════════════════
--
-- چرا p_job_id می‌گیرد و نه ده‌تا فیلد جدا؟ چون هر چیزی که از ردیف job قابل
-- خواندن است (کاربر، chat، متن ادعا، زمان‌ها) همین‌جا خوانده می‌شود. این یعنی
-- کد Node لازم نیست آن فیلدها را حمل کند، و مهم‌تر: زمان‌ها همه از ساعت
-- Postgres می‌آیند نه ساعت سرور Node. اگر دو ساعت چند ثانیه اختلاف داشته
-- باشند (که در سرورهای واقعی عادی است) اعداد latency بی‌معنی می‌شدند.
--
-- دو عدد زمانی ثبت می‌شود:
--   latency_ms  = از لحظه‌ی رسیدن پیام کاربر تا الان (کل انتظار او)
--   pipeline_ms = از لحظه‌ای که worker کار را برداشت تا الان (فقط زمان مدل)
-- اختلافشان = مدتی که کار در صف منتظر مانده.
--
-- «on conflict do nothing» یعنی اگر ردیفی با همین job_id از قبل هست، بی‌صدا
-- رد شو. تضمین می‌کند تلاش مجدد یک job، آمار را دو برابر نکند.
create or replace function public.record_check(
  p_job_id uuid,
  p_normalized_hash text,
  p_verdict_status text,
  p_confidence numeric,
  p_model_name text,
  p_sources jsonb default '[]'::jsonb,
  p_stage1_decision text default null,
  p_cache_hit boolean default false,
  p_estimated_cost_usd numeric default 0,
  p_now timestamptz default now()   -- فقط برای تست؛ production هرگز پاس نمی‌دهد
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_check_id uuid;
begin
  select * into v_job from public.jobs j where j.id = p_job_id;
  if not found then
    -- job پاک شده یا شناسه اشتباه است. متریک نباید هیچ‌وقت خطا بدهد.
    return null;
  end if;

  insert into public.checks (
    job_id, user_id, telegram_message_id, source_chat_id,
    claim_text, normalized_hash,
    verdict_status, confidence, sources, model_name, stage1_decision,
    cache_hit, latency_ms, pipeline_ms, estimated_cost_usd, created_at
  ) values (
    p_job_id, v_job.user_id, v_job.source_message_id, v_job.chat_id,
    v_job.claim_text, p_normalized_hash,
    p_verdict_status, p_confidence, coalesce(p_sources, '[]'::jsonb),
    p_model_name, p_stage1_decision,
    p_cache_hit,
    -- extract(epoch from ...) اختلاف دو زمان را به «ثانیه» می‌دهد؛ ×۱۰۰۰ = میلی‌ثانیه.
    -- greatest(0, ...) محض احتیاط: اگر ساعت عقب برود عدد منفی نشود.
    greatest(0, (extract(epoch from (p_now - v_job.created_at)) * 1000))::integer,
    greatest(0, (extract(epoch from (p_now - coalesce(v_job.claimed_at, v_job.created_at))) * 1000))::integer,
    p_estimated_cost_usd, p_now
  )
  on conflict (job_id) where job_id is not null do nothing
  returning id into v_check_id;

  return v_check_id;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- ۳) finalize_job_failure — نسخه‌ی Task 10: ثبت در audit_logs هم اضافه شد
-- ═══════════════════════════════════════════════════════════════════
--
-- بدنه‌ی این تابع عیناً همان چیزی است که در migration 0002 (Task 9) نوشته شد؛
-- فقط یک insert جدید قبل از return اضافه شده (بخش «جدید در Task 10» را ببین).
--
-- چرا اینجا و نه در کد Node؟ چون این تابع تنها گلوگاهی است که یک job در آن
-- «قطعاً شکست‌خورده» می‌شود — از fail_job، از دو مسیر در bot.ts و از بازیابی
-- هنگام بالا آمدن. ثبت در همین تراکنش یعنی هیچ شکستی از قلم نمی‌افتد.
--
-- چرا audit_logs و نه jobs؟ چون jobs هر ۷ روز پاک می‌شود. اگر نرخ خطا فقط از
-- روی jobs حساب می‌شد، تاریخچه‌ی بیشتر از یک هفته وجود نداشت.
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

  -- ─── جدید در Task 10 ───────────────────────────────────────────────
  -- متن ادعا عمداً اینجا نمی‌آید (docs/SECURITY.md §۸: PII غیرضروری ثبت نشود).
  -- متن خطا به ۵۰۰ کاراکتر بریده می‌شود تا یک stack trace طولانی جدول را باد نکند.
  insert into public.audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
  values (
    'system', v_job.telegram_id::text, 'job_failed', 'job', p_job_id::text,
    jsonb_build_object(
      'error', left(coalesce(p_error, ''), 500),
      'attempts', v_job.attempts,
      'refunded', v_refunded
    )
  );
  -- ───────────────────────────────────────────────────────────────────

  return jsonb_build_object(
    'finalized', true,
    'refunded', v_refunded,
    'job_id', v_job.id,
    'chat_id', v_job.chat_id,
    'status_message_id', v_job.status_message_id
  );
end;
$$;

-- ایندکس روی action تا شمارش «چند خطا در ۲۴ ساعت گذشته» جدول را کامل نخواند.
create index if not exists audit_logs_action_created_at_idx
  on public.audit_logs (action, created_at desc);

-- ═══════════════════════════════════════════════════════════════════
-- ۴) get_metrics_summary — همه‌ی متریک‌ها در یک شیء JSON
-- ═══════════════════════════════════════════════════════════════════
--
-- چرا یکی و نه چندتا؟ چون دستور /stats باید با «یک» رفت‌وبرگشت به دیتابیس
-- جواب بدهد. هر کوئری جدا یعنی ۱۰۰–۳۰۰ms تأخیر اضافه از سرور تا Supabase.
--
-- «with ... as (...)» در Postgres یعنی «این کوئری کوچک را اسم‌گذاری کن تا
-- پایین‌تر مثل یک جدول ازش استفاده کنم» — فقط برای خوانایی است.
--
-- «filter (where ...)» یعنی «فقط ردیف‌هایی که این شرط را دارند بشمار». یک بار
-- خواندن جدول، چند شمارش مختلف.
--
-- دو نوع خطا جدا گزارش می‌شود و این تفکیک عمدی است:
--   خطای سخت  = job اصلاً تمام نشد (audit_logs). کاربر پیام خطا دید.
--   خطای نرم  = pipeline خطا خورد ولی حکم fallback تحویل شد. کاربر «نیازمند
--               بررسی» دید و فکر کرد جواب واقعی گرفته. این‌ها بی‌صدا هستند و
--               بدون شمردنشان، نرخ خطا دروغ خوش‌بینانه می‌دهد.
create or replace function public.get_metrics_summary(
  p_window interval default interval '24 hours',
  p_now timestamptz default now()
) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with
  bounds as (select p_now - p_window as since),

  c as (
    select ch.* from public.checks ch, bounds b where ch.created_at >= b.since
  ),

  checks_agg as (
    select
      count(*)                                                as total,
      count(*) filter (where cache_hit)                       as cache_hits,
      count(*) filter (where model_name = 'cache_exact')      as cache_exact,
      count(*) filter (where model_name = 'cache_embedding')  as cache_embedding,
      count(*) filter (where stage1_decision is not null
                         and stage1_decision <> 'proceed_to_fact_check')  as triage_stops,
      count(*) filter (where not cache_hit
                         and stage1_decision = 'proceed_to_fact_check')   as full_pipeline,
      count(*) filter (where verdict_status = 'خطای سرویس')   as soft_errors,
      round(avg(latency_ms))                                  as latency_avg_ms,
      percentile_cont(0.95) within group (order by latency_ms) as latency_p95_ms,
      max(latency_ms)                                         as latency_max_ms,
      round(avg(pipeline_ms))                                 as pipeline_avg_ms,
      coalesce(sum(estimated_cost_usd), 0)                    as cost_usd
    from c
  ),

  -- هر درخواستِ پذیرفته‌شده یک ردیف 'allow' در rate_limit_events دارد؛ این
  -- مخرجِ نرخ خطاست. آن جدول از Task 9 پر می‌شود و پاک هم نمی‌شود.
  allow_agg as (
    select count(*) as allowed
      from public.rate_limit_events e, bounds b
     where e.created_at >= b.since and e.event_type = 'allow'
  ),

  fail_agg as (
    select count(*) as failed
      from public.audit_logs a, bounds b
     where a.created_at >= b.since and a.action = 'job_failed'
  ),

  -- jsonb_object_agg چند ردیف (دلیل، تعداد) را به یک شیء JSON تبدیل می‌کند:
  -- {"flood": 3, "quota_exceeded": 12}
  deny_agg as (
    select coalesce(jsonb_object_agg(d.event_type, d.n), '{}'::jsonb) as denies
    from (
      select e.event_type, count(*) as n
        from public.rate_limit_events e, bounds b
       where e.created_at >= b.since and e.event_type <> 'allow'
       group by e.event_type
    ) d
  ),

  -- وضعیت «الان» صف — بازه‌ی زمانی ندارد چون یک عکس لحظه‌ای است.
  queue_agg as (
    select
      count(*) filter (where status in ('reserved', 'pending')) as waiting,
      count(*) filter (where status = 'processing')             as running
    from public.jobs
  )

select jsonb_build_object(
  'window',             p_window::text,
  'since',              (select since from bounds),
  'checks_total',       ca.total,
  'checks_full',        ca.full_pipeline,
  'checks_cache',       ca.cache_hits,
  'cache_exact',        ca.cache_exact,
  'cache_embedding',    ca.cache_embedding,
  'checks_triage_stop', ca.triage_stops,
  'soft_errors',        ca.soft_errors,
  'cache_hit_rate',     case when ca.total > 0
                          then round(100.0 * ca.cache_hits / ca.total, 1) end,
  'latency_avg_ms',     ca.latency_avg_ms,
  'latency_p95_ms',     round(ca.latency_p95_ms::numeric),
  'latency_max_ms',     ca.latency_max_ms,
  'pipeline_avg_ms',    ca.pipeline_avg_ms,
  'cost_usd',           round(ca.cost_usd, 4),
  'requests_allowed',   aa.allowed,
  'hard_errors',        fa.failed,
  'error_rate',         case when aa.allowed > 0
                          then round(100.0 * (fa.failed + ca.soft_errors) / aa.allowed, 1) end,
  'deny_reasons',       da.denies,
  'queue_waiting',      qa.waiting,
  'queue_running',      qa.running
)
from checks_agg ca, allow_agg aa, fail_agg fa, deny_agg da, queue_agg qa;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- ۵) نگه‌داری — دو تابع نظافت که هنگام بالا آمدن پروسه صدا زده می‌شوند
-- ═══════════════════════════════════════════════════════════════════
--
-- redact_old_checks: متن ادعا را از ردیف‌های قدیمی پاک می‌کند ولی خود ردیف و
-- همه‌ی اعداد متریک را نگه می‌دارد. چرا؟ چون برای «میانگین تأخیر در ۶ ماه
-- گذشته» به عدد نیاز داریم، نه به این‌که کاربر دقیقاً چه نوشته بود.
-- normalized_hash می‌ماند (اثرانگشت SHA-256 است و برگشت‌پذیر نیست) تا اگر روزی
-- خواستیم بدانیم «چند بار یک ادعا آمده» هنوز قابل شمارش باشد.
-- docs/SECURITY.md §۶: داده‌های غیرضروری ذخیره نشوند.
create or replace function public.redact_old_checks(
  p_older_than interval default interval '180 days',
  p_now timestamptz default now()
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.checks
     set claim_text = ''
   where created_at < p_now - p_older_than
     and claim_text <> '';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- rate_limit_events از Task 9 در هر درخواست یک ردیف اضافه می‌کند و تا امروز
-- هیچ‌وقت پاک نمی‌شد. با نرخ فعلی مشکلی نیست، ولی جدولی که فقط رشد می‌کند
-- بالاخره به سقف ۵۰۰ مگابایتی پلن رایگان Supabase می‌خورد.
-- ۹۰ روز از بلندترین بازه‌ی /stats (۳۰ روز) خیلی بیشتر است.
create or replace function public.cleanup_old_rate_limit_events(
  p_older_than interval default interval '90 days',
  p_now timestamptz default now()
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.rate_limit_events where created_at < p_now - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- ۶) View‌ها — برای نگاه کردن دستی در SQL Editor پنل Supabase
-- ═══════════════════════════════════════════════════════════════════
--
-- ⓘ «view» چیست؟ یک کوئری ذخیره‌شده با اسم. هیچ داده‌ای کپی یا ذخیره نمی‌کند
--   و جای اضافه‌ای نمی‌گیرد؛ هر بار که ازش SELECT می‌گیرید، کوئری پشتش تازه
--   اجرا می‌شود. یعنی همیشه به‌روز است. مزیتش این است که به‌جای این‌که هر بار
--   ۲۰ خط SQL بنویسید، فقط می‌نویسید:  select * from v_metrics_daily;
--   و دقیقاً مثل یک جدول باهاش کار می‌کنید.
--
-- ⚠️ «with (security_invoker = on)» مهم است: بدون آن، view با دسترسی «سازنده‌اش»
--   اجرا می‌شود و قوانین RLS جدول‌های زیرین را دور می‌زند. با آن، view دسترسی
--   «کسی که ازش می‌خواند» را دارد — یعنی همان قفل‌های همیشگی سر جایشان می‌مانند.

-- ── ۱) خلاصه‌ی روزانه — اصلی‌ترین view ────────────────────────────
-- یک ردیف برای هر روز. برای دیدن روند «آیا کندتر شده؟ گران‌تر شده؟».
create or replace view public.v_metrics_daily
with (security_invoker = on) as
select
  date_trunc('day', created_at at time zone 'Asia/Tehran')::date as روز,
  count(*)                                                        as کل_بررسی,
  count(*) filter (where cache_hit)                               as از_کش,
  round(100.0 * count(*) filter (where cache_hit) / nullif(count(*), 0), 1) as درصد_کش,
  count(*) filter (where verdict_status = 'خطای سرویس')           as خطای_نرم,
  count(*) filter (where verdict_status = 'متوقف')                as توقف_triage,
  round(avg(latency_ms))                                          as میانگین_تأخیر_ms,
  round(percentile_cont(0.95) within group (order by latency_ms)::numeric) as p95_تأخیر_ms,
  round(avg(pipeline_ms))                                         as میانگین_مدل_ms,
  round(sum(estimated_cost_usd), 3)                               as هزینه_دلار
from public.checks
group by 1
order by 1 desc;

-- ── ۲) هیستوگرام تأخیر ────────────────────────────────────────────
-- «چند درصد بررسی‌ها زیر ۵ ثانیه جواب می‌گیرند؟» — خواندنش از p95 راحت‌تر است.
create or replace view public.v_latency_buckets
with (security_invoker = on) as
select
  case
    when latency_ms <  5000 then 'الف) زیر ۵ ثانیه'
    when latency_ms < 15000 then 'ب) ۵ تا ۱۵ ثانیه'
    when latency_ms < 30000 then 'ج) ۱۵ تا ۳۰ ثانیه'
    else                          'د) بیشتر از ۳۰ ثانیه'
  end                                                as بازه,
  count(*)                                           as تعداد,
  round(100.0 * count(*) / sum(count(*)) over (), 1) as درصد
from public.checks
where created_at > now() - interval '30 days' and latency_ms is not null
group by 1
order by 1;

-- ── ۳) دلایل رد شدن درخواست‌ها ────────────────────────────────────
-- rate_limit_events از Task 9 هر «اجازه» و هر «رد» را ثبت می‌کند. این view
-- همان جدول است، فقط روزانه جمع‌بندی‌شده.
-- ⚠️ نکته: duplicate_delivery اینجا نیست چون reserve_check_slot در آن حالت
-- زودتر برمی‌گردد و ردیفی ثبت نمی‌کند (رفتار موجود، عمدی).
create or replace view public.v_deny_reasons_daily
with (security_invoker = on) as
select
  date_trunc('day', created_at at time zone 'Asia/Tehran')::date as روز,
  event_type                                                      as رویداد,
  count(*)                                                        as تعداد
from public.rate_limit_events
group by 1, 2
order by 1 desc, 3 desc;

-- ── ۴) آخرین خطاها ────────────────────────────────────────────────
-- audit_logs از این migration به بعد هر job شکست‌خورده را ثبت می‌کند.
-- «->>» یعنی «این کلید را از داخل JSON بیرون بکش، به شکل متن».
create or replace view public.v_recent_failures
with (security_invoker = on) as
select
  created_at                        as زمان,
  actor_id                          as شناسه_تلگرام,
  entity_id                         as job_id,
  metadata->>'error'                as خطا,
  (metadata->>'attempts')::integer  as تلاش,
  (metadata->>'refunded')::boolean  as سهمیه_برگشت
from public.audit_logs
where action = 'job_failed'
order by created_at desc
limit 200;

-- ── ۵) پرمصرف‌ترین ردیف‌های کش ───────────────────────────────────
-- نشان می‌دهد کش واقعاً چقدر کار می‌کند: hit_count بالا یعنی یک ادعا بارها
-- آمده و ما فقط یک بار هزینه‌اش را داده‌ایم.
create or replace view public.v_cache_top_entries
with (security_invoker = on) as
select
  left(claim_text, 80)     as ادعا,
  hit_count                as تعداد_استفاده,
  result->>'status'        as حکم,
  created_at               as ساخته_شده,
  expires_at               as انقضا,
  last_accessed_at         as آخرین_استفاده
from public.cache_entries
where hit_count > 0
order by hit_count desc
limit 50;

-- Supabase به‌صورت پیش‌فرض روی چیزهای جدید در schema public به anon و
-- authenticated دسترسی خواندن می‌دهد. با security_invoker + RLS عملاً چیزی
-- نمی‌بینند، ولی صریح بستنش یک لایه‌ی محافظ اضافه است.
revoke all on public.v_metrics_daily, public.v_latency_buckets,
              public.v_deny_reasons_daily, public.v_recent_failures,
              public.v_cache_top_entries
  from anon, authenticated;
