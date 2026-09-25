import { env } from "../config/env.js";
import {
  CacheHitSchema,
  computeNormalizedHash,
  toVectorLiteral,
  type CacheHit,
} from "../domain/cache.js";
import { VerdictSchema, type Verdict } from "../domain/verdict.js";
import { embedContent } from "../infrastructure/gemini.js";
import { log } from "../infrastructure/logger.js";
import { supabase } from "../infrastructure/supabase.js";
import { claimsAreSame } from "./claimMatch.js";
import { isVerdictFallback } from "./verdict.js";

// کل این لایه fail-open است: هر خطایی (جمنای، دیتابیس، داده‌ی خراب) فقط لاگ
// می‌شود و مثل «cache miss» رفتار می‌کند. دلیل: cache یک بهینه‌سازی هزینه است،
// نه بخشی از درستی محصول — خراب شدنش هرگز نباید جلوی جواب گرفتن کاربر را بگیرد.
// (برعکس مسیر سهمیه در rateLimit.ts که عمداً fail-closed است.)

async function callFindCacheHit(
  normalizedHash: string,
  embedding: number[] | null
): Promise<CacheHit | null> {
  const { data, error } = await supabase.rpc("find_cache_hit", {
    p_normalized_hash: normalizedHash,
    p_embedding: embedding ? toVectorLiteral(embedding) : null,
    p_similarity_threshold: env.CACHE_SIMILARITY_THRESHOLD,
  });

  if (error) {
    log.error("❌ فراخوانی find_cache_hit شکست خورد:", error);
    return null;
  }

  const parsed = CacheHitSchema.safeParse(data);
  if (!parsed.success) {
    log.error("❌ خروجی find_cache_hit ساختار مورد انتظار را نداشت:", parsed.error.issues);
    return null;
  }
  return parsed.data;
}

/** نتیجه‌ی cache شده را با همان schemaی حکم زنده اعتبارسنجی می‌کند. */
function parseCachedVerdict(hit: CacheHit): Verdict | null {
  const parsed = VerdictSchema.safeParse(hit.result);
  if (!parsed.success) {
    // ردیف قدیمی که با نسخه‌ی قبلی schema ذخیره شده، یا داده‌ی خراب. نادیده
    // گرفتنش یعنی pipeline عادی اجرا و ردیف با upsert بازنویسی می‌شود.
    log.error("⚠️ نتیجه‌ی cache با schema فعلی نخواند؛ نادیده گرفته شد:", parsed.error.issues);
    return null;
  }
  return parsed.data;
}

export interface CacheLookup {
  verdict: Verdict;
  hitType: "exact" | "embedding";
}

/**
 * جستجوی جواب آماده برای یک ادعا.
 *
 * دو مرحله‌ای است تا در حالت رایج هیچ هزینه‌ای ندهد: اول فقط با hash (یک کوئری
 * ایندکس‌دار، صفر تماس API). فقط اگر چیزی پیدا نشد سراغ embedding می‌رویم که
 * یک تماس جمنای دارد — ولی همان یک تماس در برابر سه تماسِ pipeline کامل صرفه دارد.
 *
 * hitType در خروجی لازم است تا Task 10 بتواند در متریک‌ها تفکیک کند جواب از
 * تطبیق دقیق آمده یا معنایی — بدون آن نمی‌شد فهمید آستانه‌ی embedding واقعاً
 * چقدر کار می‌کند.
 */
export async function lookupCache(claimText: string): Promise<CacheLookup | null> {
  try {
    const normalizedHash = computeNormalizedHash(claimText);

    const exact = await callFindCacheHit(normalizedHash, null);
    if (exact?.hit_type === "exact") {
      log.info("cache → hit دقیق");
      const verdict = parseCachedVerdict(exact);
      return verdict ? { verdict, hitType: "exact" } : null;
    }
    if (exact === null) return null; // خطای دیتابیس؛ سراغ embedding هم نمی‌رویم

    const embedding = await embedContent(claimText);
    const similar = await callFindCacheHit(normalizedHash, embedding);

    if (similar?.hit_type === "embedding" && similar.claim_text) {
      // بردار فقط «کاندیدا» می‌دهد. قضاوت نهایی با یک تماس ارزان است، چون
      // embedding نفی/عدد/موجودیت متفاوت را نمی‌بیند (توضیح کامل در claimMatch.ts).
      const confirmed = await claimsAreSame(similar.claim_text, claimText);
      if (!confirmed) {
        log.info(`cache → miss (کاندیدا با فاصله ${similar.distance?.toFixed(4)} تأیید نشد)`);
        return null;
      }

      const verdict = parseCachedVerdict(similar);
      if (verdict && similar.entry_id) {
        // شمارنده فقط وقتی زیاد می‌شود که واقعاً به کاربر تحویل داده شود.
        const { error } = await supabase.rpc("record_cache_hit", { p_entry_id: similar.entry_id });
        if (error) log.error("⚠️ ثبت hit در cache شکست خورد:", error);
      }
      log.info(`cache → hit معنایی تأییدشده (فاصله ${similar.distance?.toFixed(4)})`);
      return verdict ? { verdict, hitType: "embedding" } : null;
    }

    log.info("cache → miss");
    return null;
  } catch (err) {
    log.error("⚠️ جستجوی cache شکست خورد؛ مثل miss ادامه می‌دهیم:", err);
    return null;
  }
}

/**
 * ذخیره‌ی حکم تازه برای استفاده‌ی بعدی.
 *
 * حکم‌های fallback ذخیره نمی‌شوند: آن‌ها یعنی «مرحله ۲ خطا خورد»، نه یک قضاوت
 * واقعی. cache کردنشان باعث می‌شد یک خرابی گذرای API تا CACHE_TTL_DAYS روز به
 * همه‌ی ادعاهای مشابه هم سرایت کند.
 *
 * ⚠️ عمداً از isVerdictFallback استفاده می‌شود و نه چک کردن
 * status === «نیازمند بررسی»: آن status یک حکم کاملاً معتبر هم هست (وقتی شواهد
 * واقعاً متناقض‌اند) و دور ریختنش یعنی هدر دادن کار درست انجام‌شده.
 */
export async function writeCache(claimText: string, verdict: Verdict): Promise<void> {
  if (isVerdictFallback(verdict)) {
    log.info("cache → ذخیره نشد (حکم fallback است)");
    return;
  }

  try {
    const embedding = await embedContent(claimText);

    // اثرانگشت منابع: برای Task 10 و بررسی‌های بعدی مفید است که بدانیم این جواب
    // بر پایه‌ی کدام منابع صادر شده بود.
    const fingerprint = verdict.sources.map((s) => s.url).sort().join("|").slice(0, 500) || null;

    const { error } = await supabase.rpc("upsert_cache_entry", {
      p_normalized_hash: computeNormalizedHash(claimText),
      p_claim_text: claimText,
      p_embedding: toVectorLiteral(embedding),
      p_result: verdict,
      p_source_fingerprint: fingerprint,
      p_ttl_days: env.CACHE_TTL_DAYS,
    });

    if (error) {
      log.error("❌ فراخوانی upsert_cache_entry شکست خورد:", error);
      return;
    }
    log.info(`cache → ذخیره شد (${env.CACHE_TTL_DAYS} روز)`);
  } catch (err) {
    log.error("⚠️ ذخیره در cache شکست خورد (بی‌اثر بر پاسخ کاربر):", err);
  }
}

/** پاک کردن ردیف‌های منقضی — مثل cleanupOldJobs هنگام بالا آمدن پروسه. */
export async function cleanupExpiredCacheEntries(): Promise<void> {
  const { data, error } = await supabase.rpc("cleanup_expired_cache_entries");
  if (error) {
    log.error("❌ پاکسازی cache منقضی شکست خورد:", error);
    return;
  }
  if (typeof data === "number" && data > 0) {
    log.info(`🧹 ${data} ردیف منقضی از cache پاک شد`);
  }
}
