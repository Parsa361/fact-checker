import { env } from "../config/env.js";
import { MetricsSummarySchema, type MetricsSummary } from "../domain/metrics.js";
import type { Source } from "../domain/verdict.js";
import { log } from "../infrastructure/logger.js";
import { supabase } from "../infrastructure/supabase.js";

// این لایه هم مثل cache.ts fail-open است: خطا فقط لاگ می‌شود، هرگز pipeline
// را متوقف نمی‌کند. متریک نباید هیچ‌وقت جواب دادن به کاربر را خراب کند.

export interface RecordCheckInput {
  jobId: string;
  normalizedHash: string;
  verdictStatus: string;
  confidence: number;
  modelName: string;
  sources?: Source[];
  stage1Decision?: string | null;
  cacheHit?: boolean;
  estimatedCostUsd?: number;
}

export async function recordCheck(input: RecordCheckInput): Promise<void> {
  const { error } = await supabase.rpc("record_check", {
    p_job_id: input.jobId,
    p_normalized_hash: input.normalizedHash,
    p_verdict_status: input.verdictStatus,
    p_confidence: input.confidence,
    p_model_name: input.modelName,
    p_sources: input.sources ?? [],
    p_stage1_decision: input.stage1Decision ?? null,
    p_cache_hit: input.cacheHit ?? false,
    p_estimated_cost_usd: input.estimatedCostUsd ?? 0,
  });
  if (error) log.error("❌ فراخوانی record_check شکست خورد:", error);
}

/** خلاصه‌ی متریک‌ها برای دستور /stats. window مثل "24 hours" یا "7 days". */
export async function getMetricsSummary(window: string): Promise<MetricsSummary | null> {
  const { data, error } = await supabase.rpc("get_metrics_summary", { p_window: window });
  if (error) {
    log.error("❌ فراخوانی get_metrics_summary شکست خورد:", error);
    return null;
  }
  const parsed = MetricsSummarySchema.safeParse(data);
  if (!parsed.success) {
    log.error("❌ خروجی get_metrics_summary ساختار مورد انتظار را نداشت:", parsed.error.issues);
    return null;
  }
  return parsed.data;
}

export async function redactOldChecks(): Promise<void> {
  const { error } = await supabase.rpc("redact_old_checks", {
    p_older_than: `${env.CHECKS_REDACT_AFTER_DAYS} days`,
  });
  if (error) log.error("❌ پاکسازی متن ادعاهای قدیمی شکست خورد:", error);
}

export async function cleanupOldRateLimitEvents(): Promise<void> {
  const { error } = await supabase.rpc("cleanup_old_rate_limit_events", {
    p_older_than: `${env.RATE_LIMIT_EVENTS_RETENTION_DAYS} days`,
  });
  if (error) log.error("❌ پاکسازی رویدادهای قدیمی rate limit شکست خورد:", error);
}
