import PQueue from "p-queue";
import { env } from "../config/env.js";

// محدودکننده هم‌زمانی درون‌پروسه‌ای (docs/RATE-LIMITING.md لایه ۲).
// پایداری کار از جدول jobs در Postgres می‌آید، نه از این صف؛ این صف فقط
// تعیین می‌کند همزمان چند job در حال اجرا باشند.
const queue = new PQueue({ concurrency: env.MAX_CONCURRENT_JOBS });

/**
 * افزودن کار به صف، بدون انتظار برای نتیجه.
 *
 * ⚠️ چرا این wrapper وجود دارد: خروجی queue.add() یک Promise است که اگر کار
 * خطا بدهد reject می‌شود. نوشتن `void queue.add(task)` یعنی یک unhandled
 * rejection، و Node به‌طور پیش‌فرض کل پروسه را با آن می‌کشد. چون dispatch ما
 * عمداً fire-and-forget است، این خطرناک‌ترین خط کل feature بود؛ پس پشت یک
 * تابع گذاشته شده تا هیچ call site نتواند فراموشش کند.
 */
export function enqueue(task: () => Promise<void>): void {
  void queue.add(task).catch((err) => {
    console.error("❌ خطای مهارنشده در کار صف:", err);
  });
}

export function queueStats(): { size: number; pending: number } {
  return { size: queue.size, pending: queue.pending };
}

/** منتظر تمام شدن کارهای در جریان می‌ماند. برای خاموش شدن تمیز. */
export async function drainQueue(timeoutMs: number): Promise<boolean> {
  if (queue.size === 0 && queue.pending === 0) return true;

  console.log(`⏳ صبر برای اتمام ${queue.pending} کار در حال اجرا و ${queue.size} کار در صف...`);
  const drained = queue.onIdle().then(() => true);
  const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs));

  return Promise.race([drained, timedOut]);
}
