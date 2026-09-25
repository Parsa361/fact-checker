import { env } from "../config/env.js";
import { log } from "../infrastructure/logger.js";
import { getMetricsSummary } from "../services/metrics.js";
import type { MetricsSummary } from "../domain/metrics.js";
import { bot } from "./instance.js";

// «24h» → interval Postgres. پیش‌فرض ۲۴ ساعت، سقف ۳۰ روز.
function parseWindow(arg: string | undefined): string | null {
  if (!arg) return "24 hours";
  const m = /^(\d{1,3})([hd])$/.exec(arg.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1) return null;
  if (m[2] === "h") return n <= 720 ? `${n} hours` : null;
  return n <= 30 ? `${n} days` : null;
}

function ms(v: number | null): string {
  return v === null ? "—" : `${(v / 1000).toFixed(1)}s`;
}

// عمداً بدون parse_mode: متن MarkdownV2 باید escape شود و یک کاراکتر جامانده
// کل پیام را رد می‌کند. برای یک ابزار داخلی این ریسک بی‌دلیل است.
function formatStats(m: MetricsSummary, label: string): string {
  const denies =
    Object.entries(m.deny_reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason} ${n}`)
      .join("، ") || "—";

  return [
    `📊 آمار ${label}`,
    ``,
    `بررسی‌ها: ${m.checks_total} (کامل ${m.checks_full} · کش ${m.checks_cache} · توقف ${m.checks_triage_stop})`,
    `نرخ کش: ${m.cache_hit_rate ?? "—"}٪ (دقیق ${m.cache_exact} · معنایی ${m.cache_embedding})`,
    `تأخیر: میانگین ${ms(m.latency_avg_ms)} · p95 ${ms(m.latency_p95_ms)} · بیشینه ${ms(m.latency_max_ms)}`,
    `زمان مدل: میانگین ${ms(m.pipeline_avg_ms)}`,
    `خطا: ${m.error_rate ?? "—"}٪ (سخت ${m.hard_errors} · نرم ${m.soft_errors} از ${m.requests_allowed})`,
    `هزینه تخمینی: $${m.cost_usd.toFixed(3)}`,
    ``,
    `رد شده: ${denies}`,
    `صف الان: ${m.queue_waiting} در انتظار · ${m.queue_running} در حال اجرا`,
  ].join("\n");
}

bot.command("stats", async (ctx) => {
  // ⚠️ عمداً هیچ پاسخی به غیرادمین داده نمی‌شود و next() هم صدا زده نمی‌شود:
  // بدون این return، دستور به handler پایین‌تر (message:text) می‌رسد و به‌عنوان
  // یک «ادعا» راستی‌آزمایی می‌شود — یعنی یک واحد از سهمیه‌ی کاربر و سه تماس جمنای.
  if (!ctx.from || !env.ADMIN_TELEGRAM_IDS.includes(ctx.from.id)) {
    log.warn(`⛔ /stats از کاربر غیرادمین ${ctx.from?.id ?? "?"}`);
    return;
  }

  const arg = ctx.match?.toString().trim() || undefined;
  const window = parseWindow(arg);
  if (!window) {
    await ctx.reply("قالب درست: /stats یا /stats 7d یا /stats 6h (حداکثر ۳۰ روز)");
    return;
  }

  const summary = await getMetricsSummary(window);
  if (!summary) {
    await ctx.reply("خواندن متریک‌ها ناموفق بود. لاگ سرور را ببین.");
    return;
  }
  await ctx.reply(formatStats(summary, arg ?? "۲۴ ساعت گذشته"));
});
