import { GrammyError } from "grammy";
import { bot } from "../bot/instance.js";
import { formatVerdictMessage } from "../bot/formatVerdict.js";
import { env } from "../config/env.js";
import { computeNormalizedHash } from "../domain/cache.js";
import { CHECK_STATUS_SOFT_ERROR, CHECK_STATUS_TRIAGE_STOP, COST_USD } from "../domain/metrics.js";
import {
  JobSchema,
  JOB_ABANDONED_MESSAGE,
  JOB_FAILED_MESSAGE,
  type Job,
  type ReapedJob,
} from "../domain/rateLimit.js";
import { TRIAGE_STOP_MESSAGES } from "../domain/triage.js";
import { enqueue } from "../infrastructure/queue.js";
import { log, withRequestId } from "../infrastructure/logger.js";
import { supabase } from "../infrastructure/supabase.js";
import { lookupCache, writeCache } from "./cache.js";
import { recordCheck } from "./metrics.js";
import { triageClaim } from "./triage.js";
import { finalizeJobFailure } from "./rateLimit.js";
import { generateVerdict, isVerdictFallback } from "./verdict.js";

/** فرستادن نتیجه: ویرایش پیام «⏳»، یا پیام تازه اگر شناسه‌اش را نداریم. */
async function deliver(job: Job, text: string, parseMode: "MarkdownV2" | undefined): Promise<void> {
  try {
    if (job.status_message_id === null) {
      await bot.api.sendMessage(job.chat_id, text, { parse_mode: parseMode });
    } else {
      await bot.api.editMessageText(job.chat_id, job.status_message_id, text, {
        parse_mode: parseMode,
      });
    }
  } catch (err) {
    // در تلاش مجدد، متن یکسان دوباره فرستاده می‌شود و تلگرام این خطا را می‌دهد.
    // این یعنی پیام از قبل درست است، پس موفقیت حساب می‌شود.
    if (err instanceof GrammyError && err.description.includes("message is not modified")) return;

    // اگر escape ناقص باشد تلگرام کل پیام MarkdownV2 را رد می‌کند؛ کاربر نباید
    // روی «در حال بررسی...» بماند (همان رفتاری که قبلاً در bot.ts بود).
    if (parseMode === "MarkdownV2") {
      log.error("❌ ارسال MarkdownV2 شکست خورد، fallback به متن ساده:", err);
      await deliver(job, text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1"), undefined);
      return;
    }
    throw err;
  }
}

/** خطاهایی که تلاش مجدد قطعاً بی‌فایده است. */
function isTerminalError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  // ۴۰۳ = کاربر ربات را بلاک کرده، ۴۰۰ chat not found — کسی نیست که به او بگوییم.
  return err.error_code === 403 || err.description.includes("chat not found");
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`job از ${ms}ms بیشتر طول کشید`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** اجرای واقعی pipeline — همان منطقی که قبلاً مستقیم در bot.ts بود. */
async function processJob(job: Job): Promise<void> {
  // اگر نتیجه از تلاش قبلی ذخیره شده، pipeline جمنای را دوباره اجرا نکن؛
  // محتمل‌ترین دلیل تلاش مجدد، شکست تحویل به تلگرام است نه شکست مدل.
  if (job.result_text !== null) {
    log.info("→ تحویل مجدد نتیجه ذخیره‌شده");
    await deliver(job, job.result_text, job.result_parse_mode === "MarkdownV2" ? "MarkdownV2" : undefined);
    return;
  }

  const normalizedHash = computeNormalizedHash(job.claim_text);

  // cache — قبل از هر تماس جمنای (docs/ARCHITECTURE.md §۲ و §۷).
  // یک hit هر دو مرحله را رد می‌کند، یعنی سه تماس صرفه‌جویی.
  const cached = await lookupCache(job.claim_text);
  if (cached) {
    const cachedText = formatVerdictMessage(cached.verdict);
    await supabase.rpc("save_job_result", {
      p_job_id: job.id,
      p_result_text: cachedText,
      p_parse_mode: "MarkdownV2",
    });
    await recordCheck({
      jobId: job.id,
      normalizedHash,
      verdictStatus: cached.verdict.status,
      confidence: cached.verdict.confidence,
      sources: cached.verdict.sources,
      modelName: cached.hitType === "exact" ? "cache_exact" : "cache_embedding",
      cacheHit: true,
      estimatedCostUsd:
        cached.hitType === "exact" ? COST_USD.cacheHitExact : COST_USD.cacheHitSemantic,
    });
    await deliver(job, cachedText, "MarkdownV2");
    return;
  }

  // مرحله ۱ — triage ارزان (docs/ARCHITECTURE.md §۳)
  const triage = await triageClaim(job.claim_text);
  log.info(`triage → decision=${triage.decision} scope=${triage.scope} confidence=${triage.confidence}`);

  if (triage.decision !== "proceed_to_fact_check") {
    const text = TRIAGE_STOP_MESSAGES[triage.decision];
    await supabase.rpc("save_job_result", {
      p_job_id: job.id,
      p_result_text: text,
      p_parse_mode: null,
    });
    await recordCheck({
      jobId: job.id,
      normalizedHash,
      verdictStatus: CHECK_STATUS_TRIAGE_STOP,
      confidence: Math.round(triage.confidence * 100),
      modelName: env.GEMINI_MODEL_TRIAGE,
      stage1Decision: triage.decision,
      estimatedCostUsd: COST_USD.triageStop,
    });
    await deliver(job, text, undefined);
    return;
  }

  // مرحله ۲ — جستجوی منابع و صدور حکم (docs/ARCHITECTURE.md §۴)
  const verdict = await generateVerdict(
    job.claim_text,
    triage.claims.map((item) => item.claim)
  );
  log.info(`verdict → status=${verdict.status} confidence=${verdict.confidence} sources=${verdict.sources.length}`);

  const text = formatVerdictMessage(verdict);
  // ذخیره «قبل از» تحویل: اگر تلگرام خطا بدهد، تلاش بعدی رایگان است.
  await supabase.rpc("save_job_result", {
    p_job_id: job.id,
    p_result_text: text,
    p_parse_mode: "MarkdownV2",
  });
  // حکم fallback یعنی pipeline خطا خورد، ولی کاربر یک پیام «نیازمند بررسی»
  // عادی می‌بیند و jobs.status هم 'done' می‌شود. اگر اینجا علامت‌گذاری نشود،
  // این خطا در هیچ متریکی دیده نمی‌شود.
  await recordCheck({
    jobId: job.id,
    normalizedHash,
    verdictStatus: isVerdictFallback(verdict) ? CHECK_STATUS_SOFT_ERROR : verdict.status,
    confidence: verdict.confidence,
    sources: verdict.sources,
    modelName: env.GEMINI_MODEL_VERDICT,
    stage1Decision: triage.decision,
    estimatedCostUsd: COST_USD.fullPipeline,
  });
  await writeCache(job.claim_text, verdict);
  await deliver(job, text, "MarkdownV2");
}

export async function runJob(jobId: string): Promise<void> {
  const { data, error } = await supabase.rpc("claim_job", { p_job_id: jobId });
  if (error) {
    log.error(`❌ claim_job برای ${jobId} شکست خورد:`, error);
    return;
  }
  if (!data) return; // یکی دیگر برش داشته یا terminal شده

  const parsed = JobSchema.safeParse(data);
  if (!parsed.success) {
    log.error("❌ ردیف job ساختار مورد انتظار را نداشت:", parsed.error.issues);
    await finalizeJobFailure(jobId, "malformed job row");
    return;
  }
  const job = parsed.data;

  await withRequestId(job.id, async () => {
    try {
      await withTimeout(processJob(job), env.JOB_TIMEOUT_MS);

      // تحویل «قبل از» complete انجام شد (at-least-once): ویرایش تکراری خیلی
      // بهتر از job‌ای است که بی‌صدا تمام شود و هیچ‌وقت به کاربر چیزی نگوید.
      const { data: done } = await supabase.rpc("complete_job", { p_job_id: job.id });
      if (done && !(done as { completed: boolean }).completed) {
        log.warn("⚠️ job قبلاً توسط مسیر دیگری terminal شده بود");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const terminal = isTerminalError(err);
      log.error(`❌ job شکست خورد (terminal=${terminal}):`, message);

      const { data: outcome } = await supabase.rpc("fail_job", {
        p_job_id: job.id,
        p_error: message,
        p_terminal: terminal,
      });

      const status = (outcome as { status?: string } | null)?.status;
      if (status === "pending") {
        log.info("job برای تلاش مجدد صف شد");
        setTimeout(() => dispatchJob(job.id), 1000);
      } else if (status === "failed" && !terminal) {
        // آخرین تلاش هم شکست خورد؛ حداقل کاربر را روی «⏳» رها نکن.
        await deliver(job, JOB_FAILED_MESSAGE, undefined).catch((e) =>
          log.error("❌ ارسال پیام خطا هم شکست خورد:", e)
        );
      }
    }
  });
}

export function dispatchJob(jobId: string): void {
  enqueue(() => runJob(jobId));
}

export async function apologizeForJob(job: ReapedJob, text: string): Promise<void> {
  try {
    if (job.status_message_id === null) {
      await bot.api.sendMessage(job.chat_id, text);
    } else {
      await bot.api.editMessageText(job.chat_id, job.status_message_id, text);
    }
  } catch (err) {
    log.error("❌ ارسال پیام عذرخواهی شکست خورد:", err);
  }
}

/**
 * بازیابی هنگام بالا آمدن پروسه — دلیل اصلی وجود جدول jobs.
 *
 * ⚠️ باید «قبل از» شروع دریافت update از تلگرام کامل شود: در حالت polling،
 * updateهای تأییدنشده دوباره تحویل داده می‌شوند؛ اگر ردیف job از قبل غیرترمینال
 * شده باشد، تحویل مجدد به کلید یکتای (user_id, source_message_id) می‌خورد و
 * بی‌صدا نادیده گرفته می‌شود.
 */
export async function recoverJobs(): Promise<{ requeued: number; abandoned: number }> {
  const { data, error } = await supabase.rpc("requeue_stale_jobs", {
    // تک‌پروسه‌ایم، پس «همه‌چیز کهنه است» درست است.
    p_claimed_before: new Date().toISOString(),
    p_max_age: `${env.JOB_MAX_RECOVERY_AGE_MINUTES} minutes`,
  });

  if (error) {
    log.error("❌ بازیابی کارها شکست خورد:", error);
    return { requeued: 0, abandoned: 0 };
  }

  const result = data as { abandon: Array<{ job_id: string }>; requeued: string[] };
  const abandon = result?.abandon ?? [];
  const requeued = result?.requeued ?? [];

  // رها کردن یکی‌یکی و در تراکنش‌های جدا، تا هنگام boot قفل چند ردیف کاربر
  // به‌طور همزمان نگه داشته نشود.
  for (const item of abandon) {
    const { data: finalized } = await supabase.rpc("finalize_job_failure", {
      p_job_id: item.job_id,
      p_error: "abandoned during startup recovery",
    });
    const info = finalized as {
      finalized?: boolean;
      chat_id?: number;
      status_message_id?: number | null;
    } | null;
    if (info?.finalized && info.chat_id) {
      await apologizeForJob(
        {
          job_id: item.job_id,
          chat_id: info.chat_id,
          status_message_id: info.status_message_id ?? null,
        },
        JOB_ABANDONED_MESSAGE
      );
    }
  }

  for (const jobId of requeued) dispatchJob(jobId);

  if (requeued.length > 0 || abandon.length > 0) {
    log.info(`♻️ بازیابی: ${requeued.length} کار دوباره صف شد، ${abandon.length} کار رها شد`);
  }
  return { requeued: requeued.length, abandoned: abandon.length };
}

export async function cleanupOldJobs(): Promise<void> {
  const { error } = await supabase.rpc("cleanup_old_jobs", { p_older_than: "7 days" });
  if (error) log.error("❌ پاکسازی کارهای قدیمی شکست خورد:", error);
}
