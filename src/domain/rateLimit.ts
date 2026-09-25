import { z } from "zod";

// دلایل رد کردن درخواست. سه تای اول مستقیماً از لایه‌های docs/RATE-LIMITING.md
// می‌آیند؛ in_flight از الزام «هم‌زمانی هر کاربر» و دو تای آخر حالت‌های داخلی‌اند.
export const DENY_REASONS = [
  "flood",
  "quota_exceeded",
  // سطل گروه جدا از سطل کاربر است (Task 13)، پس دلیل ردش هم جداست: پیام
  // «سهمیه‌ی شما تمام شد» وقتی سهمیه‌ی گروه تمام شده، به کاربر آدرس غلط می‌دهد.
  "group_quota_exceeded",
  // دفاع لایه‌ی دوم: تصمیم اصلی «ادمین اضافه کرده یا نه» موقع my_chat_member
  // گرفته می‌شود و ربات خودش leaveChat می‌کند. این دلیل فقط برای حالتی است که
  // به هر دلیلی (race، شکست leaveChat) ربات هنوز در یک گروه غیرمجاز مانده باشد.
  "group_not_authorized",
  "budget_exceeded",
  "in_flight",
  "duplicate_delivery",
  "internal_error",
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

// PostgREST گاهی bigint را به‌صورت رشته برمی‌گرداند؛ coerce هر دو حالت را می‌پذیرد.
// شناسه‌های تلگرام خیلی کوچک‌تر از 2^53 هستند پس تبدیل به number امن است.
export const ReapedJobSchema = z.object({
  job_id: z.string(),
  chat_id: z.coerce.number(),
  status_message_id: z.coerce.number().nullable(),
});
export type ReapedJob = z.infer<typeof ReapedJobSchema>;

const AllowedSchema = z.object({
  allowed: z.literal(true),
  job_id: z.string(),
  quota_used: z.number(),
  quota_limit: z.number(),
  reset_at: z.string(),
  reaped: z.array(ReapedJobSchema).default([]),
});

const DeniedSchema = z.object({
  allowed: z.literal(false),
  reason: z.enum(DENY_REASONS),
  retry_after_seconds: z.number().optional(),
  reset_at: z.string().optional(),
  reaped: z.array(ReapedJobSchema).default([]),
});

export const ReserveResultSchema = z.discriminatedUnion("allowed", [AllowedSchema, DeniedSchema]);
export type ReserveResult = z.infer<typeof ReserveResultSchema>;

export const JobSchema = z.object({
  id: z.string(),
  chat_id: z.coerce.number(),
  status_message_id: z.coerce.number().nullable(),
  claim_text: z.string(),
  attempts: z.number(),
  max_attempts: z.number(),
  result_text: z.string().nullable(),
  result_parse_mode: z.string().nullable(),
  // --- Task 10 ---
  // ⚠️ عمداً nullish و نه اجباری: اگر این schema نخواند، runJob کار را
  // «malformed» علامت می‌زند و شکست می‌دهد (fail-closed). این دو فیلد فقط
  // برای لاگ‌اند و ارزششان آن ریسک را ندارد. بقیه‌ی ستون‌های jobs (user_id،
  // source_message_id، ...) عمداً اضافه نشده‌اند چون record_check خودش
  // آن‌ها را از ردیف job می‌خواند — Node هیچ‌وقت لازمشان ندارد.
  telegram_id: z.coerce.number().nullish(),
  created_at: z.string().nullish(),
});
export type Job = z.infer<typeof JobSchema>;

// پیام‌های ثابت فارسی (سه تای اول عیناً از docs/RATE-LIMITING.md).
// duplicate_delivery اینجا نیست چون تنها دلیلی است که «هیچ پاسخی» به کاربر
// داده نمی‌شود — همان الگوی Exclude که در TRIAGE_STOP_MESSAGES هم استفاده شد.
export const RATE_LIMIT_MESSAGES: Record<
  Exclude<DenyReason, "duplicate_delivery" | "quota_exceeded" | "group_quota_exceeded">,
  string
> = {
  flood: "لطفاً چند ثانیه صبر کنید و دوباره تلاش کنید.",
  budget_exceeded: "در حال حاضر ظرفیت بررسی امروز تکمیل شده است.",
  in_flight: "یک بررسی دیگر از شما در حال انجام است. لطفاً تا پایان آن صبر کنید.",
  internal_error: "مشکلی در بررسی سهمیه پیش آمد. لطفاً کمی بعد دوباره تلاش کنید.",
  group_not_authorized: "این ربات فقط توسط سازنده آن قابل افزودن به گروه است. در حال خروج از این گروه هستم.",
};

// سهمیه روزانه پیام پویا دارد (زمان ریست و سقف)، پس برخلاف بقیه تابع است.
function withResetTime(base: string, resetAt: string | undefined): string {
  if (!resetAt) return base;

  const time = new Date(resetAt).toLocaleTimeString("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${base} سهمیه بعدی ساعت ${time} فعال می‌شود.`;
}

export function formatQuotaExceeded(resetAt: string | undefined, limit: number): string {
  return withResetTime(`سهمیه روزانه شما (${limit} بررسی) تمام شده است.`, resetAt);
}

// عمداً «این گروه» و نه «شما»: سطل گروه مشترک است و ممکن است کاربری که این پیام
// را می‌بیند حتی یک بررسی هم انجام نداده باشد. متن قبلی او را به اشتباه می‌انداخت.
export function formatGroupQuotaExceeded(resetAt: string | undefined, limit: number): string {
  return withResetTime(`سهمیه روزانه این گروه (${limit} بررسی) تمام شده است.`, resetAt);
}

// وقتی job به‌طور قطعی شکست بخورد. اشاره به refund عمدی است: بدون آن کاربر
// فکر می‌کند باگ ما یکی از بررسی‌های روزانه‌اش را خورده.
export const JOB_FAILED_MESSAGE =
  "متأسفانه بررسی این مورد با خطا مواجه شد. این مورد از سهمیه‌ی امروز شما کم نشد؛ لطفاً دوباره تلاش کنید.";

// وقتی job بعد از کرش/ری‌استارت آنقدر قدیمی باشد که پاسخ دادنش بی‌معنی است.
export const JOB_ABANDONED_MESSAGE =
  "این بررسی به‌دلیل قطعی سرویس ناتمام ماند. این مورد از سهمیه‌ی امروز شما کم نشد؛ لطفاً دوباره ارسال کنید.";
