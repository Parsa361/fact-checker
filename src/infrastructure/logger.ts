import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../config/env.js";

// این «فایل لاگ‌گیری کامل» نیست و قرار هم نیست بشود. سه کار می‌کند:
//   ۱) به احترام LOG_LEVEL خط‌های کم‌اهمیت را دور می‌ریزد
//   ۲) خودکار شناسه‌ی job جاری را جلوی هر خط می‌گذارد
//   ۳) متن کاربر را قبل از لاگ کوتاه می‌کند (docs/SECURITY.md §۸)

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[env.LOG_LEVEL];

// AsyncLocalStorage یک «متغیر همراه» است: هر چیزی که داخل withRequestId اجرا
// شود — هر عمقی از await — می‌تواند شناسه را بخواند بدون اینکه کسی آن را
// دست‌به‌دست کند. با ۴ job همزمان (MAX_CONCURRENT_JOBS)، بدون این، خط‌های لاگ
// در هم می‌شوند و هیچ راهی نیست بفهمی کدام «triage →» مال کدام کار بود.
const requestId = new AsyncLocalStorage<string>();

export function withRequestId<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return requestId.run(id.slice(0, 8), fn);
}

function emit(level: Level, message: string, ...rest: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const rid = requestId.getStore();
  const line = rid ? `[${rid}] ${message}` : message;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(line, ...rest);
}

export const log = {
  debug: (m: string, ...r: unknown[]) => emit("debug", m, ...r),
  info: (m: string, ...r: unknown[]) => emit("info", m, ...r),
  warn: (m: string, ...r: unknown[]) => emit("warn", m, ...r),
  error: (m: string, ...r: unknown[]) => emit("error", m, ...r),
};

/**
 * کوتاه کردن متن کاربر برای لاگ.
 *
 * چرا وقتی همین متن کامل در دیتابیس (jobs.claim_text و checks.claim_text)
 * ذخیره می‌شود؟ چون این دو جا فرق دارند: دیتابیس RLS دارد و فقط با
 * service_role خوانده می‌شود، ولی لاگ‌ها به ترمینال/Docker می‌روند، در
 * گزارش خطا کپی می‌شوند و کنترل دسترسی معناداری ندارند.
 * docs/SECURITY.md §۸: PII غیرضروری لاگ نشود.
 */
export function redactClaim(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…(${flat.length} کاراکتر)`;
}
