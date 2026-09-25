import { createHash } from "node:crypto";
import { z } from "zod";

// نرمال‌سازی مخصوص کلید cache — عمداً جدا از sanitizeInputText.
//
// تفاوت بنیادی: sanitize برای «چیزی که به مدل و کاربر نشان داده می‌شود» است، پس
// باید وفادار بماند (مثلاً نیم‌فاصله را نگه می‌دارد). این تابع برای «کلید تطبیق»
// است و خروجی‌اش هرگز نمایش داده نمی‌شود، پس می‌تواند با خیال راحت اطلاعات
// نگارشی را دور بریزد تا دو نگارش متفاوت از یک جمله به یک کلید برسند.

// ی/ک عربی → فارسی، تاء مربوطه → ه، انواع الف → ا.
// همه‌ی این‌ها تفاوت «رسم‌الخط» هستند نه تفاوت معنا: کاربری که با کیبورد عربی
// تایپ می‌کند «مي‌شود» می‌نویسد و کاربر فارسی «می‌شود» — یک جمله‌اند.
const LETTER_MAP: Record<string, string> = {
  "ي": "ی", // ي → ی
  "ى": "ی", // ى → ی
  "ك": "ک", // ك → ک
  "ة": "ه", // ة → ه
  "أ": "ا", // أ → ا
  "إ": "ا", // إ → ا
  "آ": "ا", // آ → ا
  "ٱ": "ا", // ٱ → ا
  "ؤ": "و", // ؤ → و
};
const LETTER_REGEX = new RegExp(`[${Object.keys(LETTER_MAP).join("")}]`, "g");

// اعراب (فتحه/کسره/ضمه/تشدید/سکون/تنوین) + الف خنجری. در فارسی معمولاً نوشته
// نمی‌شوند ولی در متن کپی‌شده از قرآن/متون عربی یا برخی کیبوردها ظاهر می‌شوند.
// U+064B تا U+0652 (تنوین/فتحه/کسره/ضمه/تشدید/سکون)، U+0670 (الف خنجری)،
// U+0653 تا U+0655 (مد/همزه‌ی بالا و پایین).
// مثل sanitize.ts با کد صریح \uXXXX نوشته شده‌اند نه گلیف خام: این‌ها نشانه‌های
// ترکیبی‌اند و در سورس روی حرف قبلی سوار می‌شوند، پس ویرایش بعدی را خطرناک می‌کنند.
const DIACRITICS_REGEX = new RegExp("[\\u064B-\\u0652\\u0653-\\u0655\\u0670]", "g");

// U+0640 کشیده/تطویل — کاراکتر صرفاً تزئینی که حروف را کش می‌دهد (مثل «سـلام»).
const TATWEEL_REGEX = new RegExp("\\u0640", "g");

// کاراکترهای نامرئیِ عرض‌صفر، شامل U+200C (نیم‌فاصله).
// همه به «فاصله» تبدیل می‌شوند، نه حذف — دلیلش در توضیح normalizeForCache.
const ZERO_WIDTH_REGEX = new RegExp("[\\u200B\\u200C\\u200D\\uFEFF\\u2060\\u180E]", "g");

// ارقام فارسی (U+06F0-U+06F9) و عربی-هندی (U+0660-U+0669) → ASCII،
// تا «۵ میلیون» و «5 میلیون» یک کلید بدهند.
const PERSIAN_DIGITS_REGEX = new RegExp("[\\u06F0-\\u06F9]", "g");
const ARABIC_DIGITS_REGEX = new RegExp("[\\u0660-\\u0669]", "g");

// علائم نگارشی فارسی/عربی/لاتین. حذف می‌شوند چون «آیا x؟» و «آیا x» یک ادعا هستند.
const PUNCTUATION_REGEX = /[.,!?;:'"«»()[\]{}،؛؟٪‐-―\-_/\\|@#$%^&*+=~`]/g;

/**
 * متن را به شکل قابل‌تطبیق برای کلید cache در می‌آورد.
 *
 * ⚠️ نیم‌فاصله (ZWNJ) به «فاصله» تبدیل می‌شود، نه حذف. اگر حذفش کنیم «می‌شود»
 * به «میشود» می‌چسبد، در حالی که کاربری که همان کلمه را با فاصله‌ی معمولی نوشته
 * («می شود» — خیلی رایج، چون همه کیبوردها نیم‌فاصله ندارند) به «می شود» می‌رسد و
 * این دو دیگر هرگز به هم نمی‌خورند. با تبدیل به فاصله، هر دو یک خروجی می‌دهند.
 */
export function normalizeForCache(text: string): string {
  let out = text.normalize("NFC");

  out = out.replace(ZERO_WIDTH_REGEX, " ");
  out = out.replace(DIACRITICS_REGEX, "");
  out = out.replace(TATWEEL_REGEX, "");
  out = out.replace(LETTER_REGEX, (ch) => LETTER_MAP[ch] ?? ch);
  out = out.replace(PERSIAN_DIGITS_REGEX, (d) => String(d.charCodeAt(0) - 0x06f0));
  out = out.replace(ARABIC_DIGITS_REGEX, (d) => String(d.charCodeAt(0) - 0x0660));
  out = out.replace(PUNCTUATION_REGEX, " ");
  out = out.toLowerCase();
  out = out.replace(/\s+/g, " ").trim();

  return out;
}

/** اثرانگشت ثابت متن نرمال‌شده — کلید مسیر «تطبیق دقیق» در find_cache_hit. */
export function computeNormalizedHash(text: string): string {
  return createHash("sha256").update(normalizeForCache(text), "utf8").digest("hex");
}

/**
 * تبدیل بردار به فرمتی که pgvector می‌فهمد.
 *
 * ⚠️ لازم است: supabase-js آرایه‌ی جاوااسکریپت را به‌صورت آرایه‌ی Postgres یعنی
 * {1,2,3} می‌فرستد، ولی pgvector فقط [1,2,3] را می‌پذیرد و بین این دو تبدیل
 * خودکار وجود ندارد.
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// خروجی تابع find_cache_hit. نتیجه‌ی cache شده با VerdictSchema جداگانه
// اعتبارسنجی می‌شود (اینجا unknown است چون ممکن است ردیف قدیمی/خراب باشد).
export const CacheHitSchema = z.object({
  hit_type: z.enum(["exact", "embedding", "miss"]),
  result: z.unknown().nullable(),
  distance: z.number().nullable(),
  // متن ادعای ذخیره‌شده — برای مقایسه‌ی نهایی در مسیر معنایی لازم است.
  claim_text: z.string().nullable().default(null),
  // فقط در مسیر معنایی پر می‌شود: شمارنده‌ی hit بعد از تأیید با آن ثبت می‌شود.
  entry_id: z.string().nullable().default(null),
});
export type CacheHit = z.infer<typeof CacheHitSchema>;
