import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN الزامی است"),
  NODE_ENV: z.string().default("development"),
  // از Task 1 وجود داشت ولی هیچ‌جا خوانده نمی‌شد. با enum شدنش، هم واقعاً
  // استفاده می‌شود (src/infrastructure/logger.ts) و هم مقدار اشتباه هنگام
  // بالا آمدن رد می‌شود نه اینکه بی‌صدا نادیده گرفته شود.
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().min(1).optional(),
  SUPABASE_URL: z.string().url("SUPABASE_URL باید یک آدرس معتبر باشد"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY الزامی است"),
  MAX_INPUT_CHARS: z.coerce.number().int().positive().default(2000),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY الزامی است"),
  // نسخه‌ها عمداً pin شده‌اند (docs/SECURITY.md §۹). مدل‌های 2.5 که در
  // TECH-SPEC.md آمده بودند منسوخ شده‌اند و برای کاربران جدید در دسترس نیستند.
  GEMINI_MODEL_TRIAGE: z.string().default("gemini-3.5-flash-lite"),
  GEMINI_MODEL_VERDICT: z.string().default("gemini-3.5-flash"),
  // مدل مرحله جستجو جداست: در تست واقعی، grounding روی مدل‌های ۳.۵ در پلن رایگان
  // خطای ۴۲۹ (سهمیه تمام‌شده) می‌دهد ولی روی gemini-2.5-flash کار می‌کند.
  GEMINI_MODEL_GROUNDING: z.string().default("gemini-2.5-flash"),

  // z.coerce.boolean() اینجا اشتباه است چون رشته‌ی "false" را هم true می‌کند
  // (Boolean("false") === true). با enum مقدارهای نامعتبر هنگام بالا آمدن رد می‌شوند.
  GOOGLE_GROUNDING_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  // --- Task 9: محدودیت نرخ و صف کار (docs/RATE-LIMITING.md) ---
  TZ: z.string().default("Asia/Tehran"),
  DAILY_FREE_CHECK_LIMIT: z.coerce.number().int().positive().default(5),
  // --- Task 13: سهمیه‌ی جدا برای گروه ---
  // سطل گروه از سطل شخصی کاربر جداست (بررسی در گروه از سهمیه‌ی شخصی کم نمی‌کند).
  // عدد بزرگ‌تر از سهمیه‌ی فردی است چون بین همه‌ی اعضای گروه تقسیم می‌شود، ولی
  // سقف دارد تا یک گروه پرترافیک کل GLOBAL_DAILY_API_BUDGET را نبلعد.
  GROUP_DAILY_CHECK_LIMIT: z.coerce.number().int().positive().default(20),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(4),
  // nonnegative نه positive: مقدار ۰ یعنی توقف کامل مصرف API بدون نیاز به deploy
  GLOBAL_DAILY_API_BUDGET: z.coerce.number().int().nonnegative().default(2000),
  FLOOD_WINDOW_SECONDS: z.coerce.number().int().positive().default(30),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  JOB_STUCK_AFTER_MINUTES: z.coerce.number().int().positive().default(10),
  JOB_MAX_RECOVERY_AGE_MINUTES: z.coerce.number().int().positive().default(30),
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().positive().default(60_000),
  // --- Task 8: کش با pgvector (docs/ARCHITECTURE.md §۷) ---
  CACHE_TTL_DAYS: z.coerce.number().int().positive().default(14),
  // text-embedding-004 که در نسخه‌ی اولیه‌ی مستندات آمده بود دیگر وجود ندارد
  // (خطای ۴۰۴ در تست واقعی) — همان تله‌ی مدل‌های منسوخ که در Task 6 هم خوردیم.
  GEMINI_MODEL_EMBEDDING: z.string().default("gemini-embedding-001"),
  // فاصله‌ی کسینوسی pgvector: ۰ یعنی دقیقاً یک معنا، هرچه بزرگ‌تر نامرتبط‌تر.
  //
  // این عدد «تصمیم نهایی» نیست، فقط تور اولیه است: هر چیزی که از این نزدیک‌تر
  // باشد به‌عنوان کاندیدا به دروازه‌ی تأیید (claimMatch.ts) فرستاده می‌شود.
  // مقدارش از اندازه‌گیری واقعی روی ادعاهای فارسی آمده — بازنویسی‌های درست تا
  // فاصله‌ی ۰.۱۰ دیده شدند و نزدیک‌ترین ادعای واقعاً نامرتبط ۰.۱۳ بود.
  // خیلی پایین آوردنش یعنی از دست دادن بازنویسی‌های درست؛ خیلی بالا بردنش فقط
  // تماس تأیید بیهوده خرج می‌کند (نه جواب غلط، چون تأیید جلویش را می‌گیرد).
  CACHE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(2).default(0.12),
  TAVILY_API_KEY: z.string().optional(),
  TAVILY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // وقتی grounding به سقف سهمیه می‌خورد، این مدت مستقیم سراغ Tavily می‌رویم
  // به‌جای اینکه هر درخواست دوباره سه بار retry کند (services/evidence.ts).
  //
  // ۵ دقیقه از اندازه‌گیری واقعی آمد، نه حدس: در تست، ۴۲۹ گرفتن معمولاً «سقف در
  // دقیقه» بود و تلاش سوم موفق می‌شد — یعنی سهمیه‌ی روزانه تمام نشده بود. با
  // cooldown بلند، grounding را ساعت‌ها بی‌دلیل کنار می‌گذاشتیم در حالی که
  // کیفیت منابعش از Tavily بهتر است. کوتاه‌تر از این هم بی‌فایده است چون پنجره‌ی
  // سقف در دقیقه باید فرصت بازشدن پیدا کند.
  GROUNDING_QUOTA_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(5),

  // --- Task 10: متریک‌ها، audit و /stats ---
  // شناسه‌های عددی تلگرام ادمین‌ها، با کاما جدا. خالی = دستور /stats برای هیچ‌کس
  // کار نمی‌کند (پیش‌فرض امن). شناسه‌ی خودت را با فرستادن /start به
  // @userinfobot می‌گیری.
  ADMIN_TELEGRAM_IDS: z
    .string()
    .default("")
    .transform((raw) => raw.split(",").map((v) => v.trim()).filter(Boolean).map(Number))
    .refine((ids) => ids.every((id) => Number.isInteger(id) && id > 0), {
      message: "ADMIN_TELEGRAM_IDS باید فهرستی از شناسه‌های عددی تلگرام جداشده با کاما باشد",
    }),
  CHECKS_REDACT_AFTER_DAYS: z.coerce.number().int().positive().default(180),
  RATE_LIMIT_EVENTS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
});

const envSchemaWithRules = envSchema.superRefine((data, ctx) => {
  if (data.PUBLIC_BASE_URL && !data.WEBHOOK_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["WEBHOOK_SECRET"],
      message: "برای حالت webhook (وقتی PUBLIC_BASE_URL ست شده)، WEBHOOK_SECRET الزامی است",
    });
  }

  if (data.TAVILY_ENABLED && !data.TAVILY_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["TAVILY_API_KEY"],
      message: "وقتی TAVILY_ENABLED=true است، TAVILY_API_KEY الزامی است",
    });
  }

  // اگر آستانه‌ی «گیرکرده» کوتاه‌تر از timeout خود job باشد، reaper کارهایی را که
  // هنوز مشروع در حال اجرا هستند terminal و refund می‌کند و worker بعداً می‌بیند
  // که complete_job‌اش هیچ ردیفی برنگرداند. شکست هنگام بالا آمدن خیلی بهتر از
  // دیباگ کردن آن حالت است.
  if (data.JOB_STUCK_AFTER_MINUTES * 60_000 <= data.JOB_TIMEOUT_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["JOB_STUCK_AFTER_MINUTES"],
      message:
        "JOB_STUCK_AFTER_MINUTES باید از JOB_TIMEOUT_MS بزرگ‌تر باشد، وگرنه کارهای در حال اجرا اشتباهاً گیرکرده تشخیص داده می‌شوند",
    });
  }
});

const parsed = envSchemaWithRules.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ خطا در خواندن متغیرهای محیطی:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
