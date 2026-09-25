import type { Server } from "node:http";
import { bot } from "./bot/bot.js";
import { startWebhookServer } from "./bot/webhook.js";
import { env } from "./config/env.js";
import { drainQueue } from "./infrastructure/queue.js";
import { cleanupExpiredCacheEntries } from "./services/cache.js";
import { cleanupOldJobs, recoverJobs } from "./services/jobRunner.js";
import { cleanupOldRateLimitEvents, redactOldChecks } from "./services/metrics.js";

// ⚠️ بازیابی باید «قبل از» شروع دریافت update تمام شود. در حالت polling،
// updateهایی که تأیید نشده‌اند دوباره تحویل داده می‌شوند؛ اگر ردیف job از قبل
// غیرترمینال شده باشد، تحویل مجدد به کلید یکتای (user_id, source_message_id)
// می‌خورد و بی‌صدا نادیده گرفته می‌شود. برعکسش یعنی پردازش دوتایی.
await recoverJobs();
void cleanupOldJobs();
void cleanupExpiredCacheEntries();
void redactOldChecks();
void cleanupOldRateLimitEvents();

let server: Server | undefined;

if (env.PUBLIC_BASE_URL) {
  server = await startWebhookServer();
} else {
  bot.start({
    onStart: (botInfo) => {
      console.log(`🤖 ربات @${botInfo.username} با polling شروع به کار کرد.`);
    },
  });
}

// خاموش شدن تمیز، مکمل بازیابی هنگام شروع است: اگر کارهای در جریان قبل از
// خاموشی تمام شوند، اکثر deployها اصلاً نیازی به بازیابی پیدا نمی‌کنند.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 ${signal} دریافت شد؛ در حال خاموش شدن...`);

  await bot.stop().catch(() => {});
  server?.close();

  const drained = await drainQueue(env.SHUTDOWN_DRAIN_MS);
  console.log(
    drained
      ? "✅ همه کارها تمام شدند."
      : "⚠️ مهلت خاموشی تمام شد؛ کارهای ناتمام هنگام شروع بعدی بازیابی می‌شوند."
  );
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
