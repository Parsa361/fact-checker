import { z } from "zod";

// تخمین هزینه — عمداً «ثابت» و نه محاسبه‌ی واقعی توکن.
//
// چرا؟ گران‌ترین تماس pipeline (جستجوی grounded گوگل) اصلاً بر اساس توکن
// حساب نمی‌شود، بلکه «به‌ازای هر جستجو» است. پس شمردن توکن‌ها یک عدد دقیق
// برای بخش ارزان می‌داد و درباره‌ی بخش گران هیچ نمی‌گفت.
//
// این اعداد از docs/TECH-SPEC.md §۷ می‌آیند (~$۰.۰۱ برای هر بررسی بدون کش).
// دقتشان در حد «مرتبه‌ی بزرگی» است و هدفشان دیدن *روند* است نه صورت‌حساب.
// هر عدد هزینه‌ی *کل* آن مسیر را در بر می‌گیرد، از جمله تماس embedding کش.
export const COST_USD = {
  cacheHitExact: 0, // تطبیق hash — صفر تماس API
  cacheHitSemantic: 0.0006, // یک embedding + یک تماس تأیید flash-lite
  triageStop: 0.001, // embedding کش (miss) + یک تماس triage
  fullPipeline: 0.01, // triage + جستجوی grounded + صدور حکم + embedding‌ها
} as const;

// دو مقدار «نشانه‌ای» برای ستون verdict_status که حکم واقعی نیستند.
// عمداً عضو VerdictStatusSchema نیستند تا هیچ‌وقت با یک حکم واقعی اشتباه نشوند.
export const CHECK_STATUS_TRIAGE_STOP = "متوقف";
export const CHECK_STATUS_SOFT_ERROR = "خطای سرویس";

// خروجی get_metrics_summary — همه‌ی فیلدهای عددی می‌توانند null باشند
// (جدول خالی، یا بازه‌ای بدون هیچ رخداد).
export const MetricsSummarySchema = z.object({
  window: z.string(),
  since: z.string(),
  checks_total: z.number(),
  checks_full: z.number(),
  checks_cache: z.number(),
  cache_exact: z.number(),
  cache_embedding: z.number(),
  checks_triage_stop: z.number(),
  soft_errors: z.number(),
  cache_hit_rate: z.number().nullable(),
  latency_avg_ms: z.number().nullable(),
  latency_p95_ms: z.number().nullable(),
  latency_max_ms: z.number().nullable(),
  pipeline_avg_ms: z.number().nullable(),
  cost_usd: z.number(),
  requests_allowed: z.number(),
  hard_errors: z.number(),
  error_rate: z.number().nullable(),
  deny_reasons: z.record(z.string(), z.number()),
  queue_waiting: z.number(),
  queue_running: z.number(),
});
export type MetricsSummary = z.infer<typeof MetricsSummarySchema>;
