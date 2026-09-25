import { env } from "../config/env.js";
import { log } from "../infrastructure/logger.js";
import { supabase } from "../infrastructure/supabase.js";
import { ReserveResultSchema, type ReserveResult } from "../domain/rateLimit.js";

export interface ReserveInput {
  telegramId: number;
  username?: string;
  chatId: number;
  sourceMessageId: number;
  claimText: string;
  // Task 13: کدام سطل سهمیه مصرف شود. صریح پاس داده می‌شود و از روی علامت
  // chat_id حدس زده نمی‌شود (شناسه‌ی گروه در تلگرام منفی است، ولی تکیه به آن
  // یعنی یک invariant نانوشته‌ی پلتفرم وسط منطق سهمیه قایم شود).
  isGroup: boolean;
  chatTitle?: string;
}

// وقتی خود RPC یا اعتبارسنجی خروجی‌اش شکست بخورد، محافظه‌کارانه رد می‌کنیم
// (docs/TECH-SPEC.md §۸). دلیل جدا بودن internal_error از quota_exceeded: نشان
// دادن «سهمیه تمام شد» وقتی واقعاً خطای دیتابیس بوده، به کاربر دروغ گفتن است.
function failClosed(context: string, detail: unknown): ReserveResult {
  log.error(`❌ ${context}:`, detail);
  return { allowed: false, reason: "internal_error", reaped: [] };
}

/**
 * رزرو اتمیک یک بررسی: سهمیه روزانه، بودجه سراسری، ضد flood، هم‌زمانی هر کاربر،
 * تشخیص تحویل تکراری و ساخت ردیف job — همه در یک تراکنش.
 */
export async function reserveCheckSlot(input: ReserveInput): Promise<ReserveResult> {
  const { data, error } = await supabase.rpc("reserve_check_slot", {
    p_telegram_id: input.telegramId,
    p_username: input.username ?? null,
    p_chat_id: input.chatId,
    p_source_message_id: input.sourceMessageId,
    p_claim_text: input.claimText,
    p_daily_limit: env.DAILY_FREE_CHECK_LIMIT,
    p_budget_limit: env.GLOBAL_DAILY_API_BUDGET,
    p_flood_seconds: env.FLOOD_WINDOW_SECONDS,
    p_stuck_after: `${env.JOB_STUCK_AFTER_MINUTES} minutes`,
    p_max_attempts: env.JOB_MAX_ATTEMPTS,
    p_timezone: env.TZ,
    p_is_group: input.isGroup,
    p_group_limit: env.GROUP_DAILY_CHECK_LIMIT,
    p_chat_title: input.chatTitle ?? null,
  });

  if (error) return failClosed("فراخوانی reserve_check_slot شکست خورد", error);

  const parsed = ReserveResultSchema.safeParse(data);
  if (!parsed.success) {
    // اگر RPC کامیت شده ولی اعتبارسنجی شکست خورده باشد، ردیف reserved یتیم
    // می‌ماند؛ reaper یا بازیابی هنگام boot پاکش می‌کند.
    return failClosed("خروجی reserve_check_slot ساختار مورد انتظار را نداشت", {
      issues: parsed.error.issues,
      data,
    });
  }

  return parsed.data;
}

/** reserved → pending. تا این لحظه job قابل برداشت نیست. */
export async function markJobReady(jobId: string, statusMessageId: number): Promise<boolean> {
  const { data, error } = await supabase.rpc("mark_job_ready", {
    p_job_id: jobId,
    p_status_message_id: statusMessageId,
  });

  if (error) {
    log.error("❌ فراخوانی mark_job_ready شکست خورد:", error);
    return false;
  }
  if (data && typeof data === "object" && "error" in data) {
    log.error("❌ mark_job_ready:", (data as { error: string }).error);
    return false;
  }
  return true;
}

/** terminal کردن job همراه با refund سهمیه. */
export async function finalizeJobFailure(jobId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc("finalize_job_failure", {
    p_job_id: jobId,
    p_error: reason,
  });
  if (error) log.error("❌ فراخوانی finalize_job_failure شکست خورد:", error);
}

/**
 * ثبت/به‌روزرسانی مجوز یک گروه — تنها جایی که ستون authorized نوشته می‌شود.
 * از bot.ts روی رویداد my_chat_member صدا زده می‌شود (وقتی ربات به یک گروه
 * اضافه می‌شود). یک upsert تک‌ردیفی است، نه RPC: برخلاف reserve_check_slot که
 * چند جدول را با هم قفل می‌کند، این فقط یک ردیف را می‌نویسد و خودِ PostgREST هم
 * برای همین اتمیک است.
 */
export async function upsertGroupAuthorization(input: {
  chatId: number;
  title: string | undefined;
  authorized: boolean;
  authorizedBy: number;
}): Promise<boolean> {
  const { error } = await supabase.from("group_chats").upsert(
    {
      chat_id: input.chatId,
      title: input.title ?? null,
      authorized: input.authorized,
      authorized_by: input.authorizedBy,
    },
    { onConflict: "chat_id" }
  );

  if (error) {
    log.error("❌ ثبت مجوز گروه شکست خورد:", error);
    return false;
  }
  return true;
}
