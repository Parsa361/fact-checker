// طبق docs/SECURITY.md بخش ۵ (Validation و input safety):
// strip کردن whitespace اضافی و zero-width chars، و truncate قبل از ارسال به LLM.
//
// نکته مهم: U+200C (ZWNJ / نیم‌فاصله) عمداً از لیست حذف نمی‌شود چون در نگارش صحیح
// فارسی معنادار است (مثلاً «می‌روم» با نیم‌فاصله بین «می» و «روم» نوشته می‌شود).
// حذفش کلمات فارسی را به‌هم می‌ریزد.
//
// کاراکترهایی که حذف می‌شوند (با کد یونیکد صریح \uXXXX، نه گلیف نامرئی خام در سورس):
// - U+200B zero width space, U+FEFF (BOM), U+2060 word joiner, U+180E: نامرئی و بی‌فایده
// - U+200D (ZWJ): معمولاً برای دنباله‌ی ایموجی است، در متن فارسی معنی ندارد
// - U+202A تا U+202E و U+2066 تا U+2069 (کنترل‌های bidi/RTL override): می‌توانند برای
//   گمراه‌ کردن بصری یا مخفی‌کردن متن استفاده شوند — ریسک امنیتی، پس حذف می‌شوند.
const INVISIBLE_CHARS_REGEX = new RegExp(
  "[\\u200B\\u200D\\uFEFF\\u2060\\u180E\\u202A-\\u202E\\u2066-\\u2069]",
  "g"
);

export function sanitizeInputText(raw: string, maxChars: number): string {
  const withoutInvisible = raw.replace(INVISIBLE_CHARS_REGEX, "");
  const collapsedWhitespace = withoutInvisible.replace(/\s+/g, " ").trim();
  return collapsedWhitespace.slice(0, maxChars);
}
