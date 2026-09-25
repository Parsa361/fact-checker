import { z } from "zod";

// طبق docs/TECH-SPEC.md بخش ۲ (قرارداد خروجی Stage 1)
// حوزه‌های مجاز طبق docs/PRD.md بخش ۵: سلامت، علم، فناوری، اقتصاد، شایعات عمومی
export const TriageScopeSchema = z.enum([
  "health",
  "science",
  "technology",
  "economy",
  "general_rumor",
  "out_of_scope",
]);
export type TriageScope = z.infer<typeof TriageScopeSchema>;

export const TriageDecisionSchema = z.enum([
  "proceed_to_fact_check",
  "reject_out_of_scope",
  "not_verifiable",
  "too_recent_yet",
  "needs_human_review",
]);
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;

export const ClaimSchema = z.object({
  claim: z.string(),
  type: z.enum(["numeric", "event", "medical", "scientific", "economic", "other"]),
  priority: z.enum(["high", "medium", "low"]),
});

export const TriageResultSchema = z.object({
  has_fact_checkable_claim: z.boolean(),
  scope: TriageScopeSchema,
  decision: TriageDecisionSchema,
  reason: z.string(),
  claims: z.array(ClaimSchema).default([]),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  confidence: z.number().min(0).max(1),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

// پیام‌های فارسی برای تصمیم‌هایی که pipeline را متوقف می‌کنند.
// (decision === "proceed_to_fact_check" یعنی برو مرحله ۲، پیام ندارد.)
export const TRIAGE_STOP_MESSAGES: Record<Exclude<TriageDecision, "proceed_to_fact_check">, string> =
  {
    reject_out_of_scope:
      "این موضوع خارج از حوزه‌ی بررسی این ربات است. حوزه‌های تحت پوشش: سلامت، علم، فناوری، اقتصاد و شایعات عمومی.",
    not_verifiable:
      "این متن ادعای مشخص و قابل راستی‌آزمایی ندارد. لطفاً یک خبر یا ادعای مشخص بفرستید.",
    too_recent_yet:
      "⏳ این خبر خیلی تازه است و هنوز منابع معتبر کافی برای راستی‌آزمایی آن منتشر نشده. کمی بعد دوباره تلاش کنید.",
    needs_human_review:
      "🟡 این ادعا نیاز به بررسی انسانی دارد و ربات نمی‌تواند با اطمینان کافی درباره‌اش نظر بدهد.",
  };
