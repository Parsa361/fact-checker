-- Task 8 — کش نتایج با pgvector
-- بر اساس docs/ARCHITECTURE.md §۷ (استراتژی cache) و §۲ (جای cache در جریان کار)
--
-- چرا اصلاً cache؟ هر بررسی سه تماس جمنای می‌خورد (triage، جستجوی منابع، صدور
-- حکم). وقتی یک شایعه داغ می‌شود، ده‌ها نفر عملاً یک ادعا را می‌فرستند و ما
-- سه‌برابرِ آن تعداد تماس API خرج می‌کنیم برای رسیدن به همان یک جواب.
--
-- ─── دو مسیر برای پیدا کردن جواب آماده ───────────────────────────────
--
-- مسیر ۱ «hash دقیق»: متن ادعا اول نرمال می‌شود (حروف عربی به فارسی، حذف
--   اعراب، یکسان‌سازی ارقام، حذف علائم نگارشی...) و بعد یک اثرانگشت ثابت
--   SHA-256 از آن ساخته می‌شود. دو نفر که *عملاً* یک جمله را نوشته‌اند — حتی
--   با نگارش کمی متفاوت — به یک hash می‌رسند. جستجویش با ایندکس unique
--   معمولی است، یعنی خیلی سریع و بدون هیچ هزینه‌ای.
--
-- مسیر ۲ «embedding»: یک بردار ۷۶۸ عددی که جمنای از *معنای* جمله می‌سازد.
--   دو جمله‌ی هم‌معنی با کلمات کاملاً متفاوت («تیتر مشابه» در چک‌لیست Task 8)
--   بردارهای نزدیک به هم دارند. عملگر `<=>` فاصله‌ی کسینوسی می‌دهد:
--   ۰ = دقیقاً یک معنا، هرچه بزرگ‌تر یعنی نامرتبط‌تر.
--
--   ⚠️ این مسیر به‌تنهایی قابل اعتماد نیست و خروجی‌اش فقط «کاندیدا» است.
--   اندازه‌گیری واقعی روی متن فارسی نشان داد مدل‌های embedding نفی را تقریباً
--   نمی‌بینند: فاصله‌ی «ماسک از انتقال جلوگیری می‌کند» تا «...جلوگیری نمی‌کند»
--   فقط ۰.۰۴۴ بود، یعنی *نزدیک‌تر* از خیلی بازنویسی‌های کاملاً درست (تا ۰.۱۰).
--   پس هیچ آستانه‌ای نمی‌تواند این دو را از هم جدا کند. برای یک ربات
--   راستی‌آزمایی این یعنی خطر دادن جواب «وارونه» با اطمینان کامل.
--   راه‌حل: تصمیم نهایی را یک تماس ارزان مدل می‌گیرد (src/services/cache.ts).
--
-- ─── چرا ایندکس HNSW و نه ivfflat؟ ──────────────────────────────────
-- بدون ایندکس، Postgres باید فاصله را با تک‌تک ردیف‌های جدول حساب کند.
-- ivfflat برای اینکه دقیق کار کند باید اول روی یک نمونه‌ی قابل‌توجه از داده
-- «آموزش» ببیند (ردیف‌ها را خوشه‌بندی می‌کند)، پس روی جدول خالی یا کم‌ردیف
-- بد عمل می‌کند — و جدول ما دقیقاً از صفر شروع می‌شود. HNSW چنین نیازی ندارد
-- و از همان ردیف اول درست کار می‌کند.

create index if not exists cache_entries_embedding_hnsw_idx
  on public.cache_entries
  using hnsw (embedding extensions.vector_cosine_ops);

-- ═══════════════════════════════════════════════════════════════════
-- find_cache_hit — جستجوی جواب آماده (اول دقیق، بعد معنایی)
-- ═══════════════════════════════════════════════════════════════════
--
-- p_embedding عمداً nullable است: کد اول این تابع را *بدون* بردار صدا می‌زند
-- (فقط مسیر دقیق، صفر هزینه) و تنها اگر چیزی پیدا نشد، بردار را از جمنای
-- می‌گیرد و دوباره صدا می‌زند. این‌طور برای حالت رایج «عین همان ادعا» هیچ
-- تماس embedding خرج نمی‌شود.
--
-- در هر دو مسیر hit_count و last_accessed_at در همان تراکنش به‌روز می‌شوند
-- (متریک «نرخ cache hit» در Task 10 روی همین ستون‌ها بنا می‌شود).
--
-- ⚠️ نکته‌ی فنی: طبق قرارداد این پروژه هر تابع search_path را خالی می‌گذارد و
-- همه‌چیز را صریح schema-qualify می‌کند. برای *عملگرها* این یعنی نوشتن
-- `a <=> b` کافی نیست — عملگر از طریق search_path پیدا می‌شود و extensions
-- روی search_path خالی نیست. پس باید صریح OPERATOR(extensions.<=>) نوشت.
-- (هیچ تابع قبلی این پروژه عملگر خارج از pg_catalog نداشت، پس این تله تا
-- حالا به چشم نیامده بود.)
create or replace function public.find_cache_hit(
  p_normalized_hash text,
  p_embedding extensions.vector(768) default null,
  p_similarity_threshold double precision default 0.12,
  p_now timestamptz default now()   -- فقط برای تست؛ production هرگز پاس نمی‌دهد
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_result jsonb;
  v_claim_text text;
  v_distance double precision;
begin
  -- مسیر ۱ — تطبیق دقیق روی hash نرمال‌شده
  select id, result, claim_text into v_id, v_result, v_claim_text
    from public.cache_entries
   where normalized_hash = p_normalized_hash
     and expires_at > p_now
   limit 1;

  if v_id is not null then
    update public.cache_entries
       set hit_count = hit_count + 1,
           last_accessed_at = p_now
     where id = v_id;
    return jsonb_build_object(
      'hit_type', 'exact', 'result', v_result, 'distance', 0, 'claim_text', v_claim_text
    );
  end if;

  -- مسیر ۲ — نزدیک‌ترین ادعا از نظر معنایی
  if p_embedding is not null then
    select id, result, claim_text, embedding OPERATOR(extensions.<=>) p_embedding
      into v_id, v_result, v_claim_text, v_distance
      from public.cache_entries
     where expires_at > p_now
       and embedding is not null
     order by embedding OPERATOR(extensions.<=>) p_embedding
     limit 1;

    -- فیلتر آستانه *بعد از* پیدا کردن نزدیک‌ترین انجام می‌شود، نه در where:
    -- این‌طور ایندکس HNSW می‌تواند کوئری را جواب بدهد.
    --
    -- ⚠️ اینجا hit_count زیاد *نمی‌شود*: این فقط یک «کاندیدا» است. تصمیم نهایی
    -- را لایه‌ی بالاتر با یک تماس تأیید مدل می‌گیرد (دلیلش در src/services/cache.ts).
    if v_id is not null and v_distance <= p_similarity_threshold then
      return jsonb_build_object(
        'hit_type', 'embedding', 'result', v_result, 'entry_id', v_id,
        'distance', v_distance, 'claim_text', v_claim_text
      );
    end if;
  end if;

  return jsonb_build_object(
    'hit_type', 'miss', 'result', null, 'distance', null, 'claim_text', null
  );
end;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- record_cache_hit — ثبت hit بعد از تأیید
-- ═══════════════════════════════════════════════════════════════════
--
-- مسیر دقیق شمارنده‌اش را همان‌جا زیاد می‌کند، ولی مسیر معنایی نه: آنجا فقط یک
-- «کاندیدا» داریم که هنوز باید با مدل تأیید شود. این تابع برای همان لحظه‌ی
-- تأیید است، تا آمار hit با چیزی که واقعاً به کاربر تحویل داده شده بخواند.
create or replace function public.record_cache_hit(
  p_entry_id uuid,
  p_now timestamptz default now()
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.cache_entries
     set hit_count = hit_count + 1,
         last_accessed_at = p_now
   where id = p_entry_id;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- upsert_cache_entry — ذخیره‌ی نتیجه‌ی یک بررسی تازه
-- ═══════════════════════════════════════════════════════════════════
--
-- «upsert» یعنی اگر ردیفی با این hash نبود insert کن، اگر بود update کن.
-- بدون این، ذخیره‌ی دوباره‌ی یک ادعای منقضی‌شده به خطای unique می‌خورد.
--
-- hit_count عمداً روی conflict دست نمی‌خورد: وقتی یک ادعای پرطرفدار منقضی
-- می‌شود و دوباره بررسی می‌شود، تاریخچه‌ی محبوبیتش نباید صفر شود.
create or replace function public.upsert_cache_entry(
  p_normalized_hash text,
  p_claim_text text,
  p_embedding extensions.vector(768),
  p_result jsonb,
  p_source_fingerprint text default null,
  p_ttl_days integer default 14,
  p_now timestamptz default now()   -- فقط برای تست؛ production هرگز پاس نمی‌دهد
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.cache_entries (
    normalized_hash, claim_text, embedding, result, source_fingerprint, expires_at
  ) values (
    p_normalized_hash, p_claim_text, p_embedding, p_result, p_source_fingerprint,
    p_now + make_interval(days => p_ttl_days)
  )
  on conflict (normalized_hash) do update
    set claim_text = excluded.claim_text,
        embedding = excluded.embedding,
        result = excluded.result,
        source_fingerprint = excluded.source_fingerprint,
        expires_at = excluded.expires_at;
        -- hit_count عمداً دست‌نخورده می‌ماند
end;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- cleanup_expired_cache_entries — نظافت دوره‌ای
-- ═══════════════════════════════════════════════════════════════════
--
-- ردیف منقضی به‌خاطر شرط expires_at در find_cache_hit عملاً نامرئی است، پس
-- این تابع برای «درستی» لازم نیست — برای این است که ردیف‌های مرده تا ابد در
-- ایندکس HNSW نمانند و جستجو را کند نکنند. مثل cleanup_old_jobs هنگام بالا
-- آمدن پروسه صدا زده می‌شود.
create or replace function public.cleanup_expired_cache_entries(
  p_now timestamptz default now()
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.cache_entries where expires_at <= p_now;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
