# Fact Check فارسی — ربات فکت‌چک تلگرام

**English:** A Telegram bot that fact-checks Persian news through a two-stage Gemini pipeline (cheap triage → grounded verdict), with Supabase/pgvector caching, multi-layer rate limiting and group-chat support. Built end to end with Claude Code.

کاربر یک خبر یا ادعا را برای ربات فوروارد می‌کند. ربات با AI ادعاهای قابل راستی‌آزمایی را استخراج می‌کند، با web search grounding منبع پیدا می‌کند و یکی از این وضعیت‌ها را برمی‌گرداند: تأیید · رد · نیازمند بررسی · غیرقابل راستی‌آزمایی · هنوز قابل راستی‌آزمایی نیست — همراه با confidence score و لینک منابع.

## وضعیت فعلی

MVP کار می‌کند و به‌صورت end-to-end تست شده:

- Pipeline دو مرحله‌ای: Triage ارزان با Gemini Flash-Lite → صدور حکم با Gemini Flash + Google Search grounding، با fallback به Tavily
- Cache معنایی با pgvector روی Supabase
- Rate limiting چندلایه (سهمیه روزانه شخصی و گروهی، صف کار پایدار با رترای)
- پشتیبانی از چت خصوصی و گروهی (mention/reply)
- متریک پایه و دستور ادمین /stats

## استک

Node.js · TypeScript · grammY (Telegram) · Supabase (Postgres + pgvector) · Gemini (triage/verdict/grounding) · Tavily (fallback) · Docker

## ساختار

\`\`\`
src/
  bot/            # هندلرهای تلگرام
  config/         # اعتبارسنجی env با zod
  domain/         # منطق دامنه
  infrastructure/ # اتصال به Supabase، Gemini، Tavily
  services/       # pipeline و کش
supabase/migrations/  # اسکیمای دیتابیس (Postgres + pgvector)
\`\`\`

> این یک کپی عمومی از پروژه است که فقط کد را نشان می‌دهد؛ مستندات محصول، معماری و تصمیم‌های استراتژیک در مخزن خصوصی اصلی نگهداری می‌شوند.
