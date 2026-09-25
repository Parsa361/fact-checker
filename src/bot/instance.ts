import { Bot } from "grammy";
import { env } from "../config/env.js";
import { proxyFetch } from "../infrastructure/proxyFetch.js";

// instance ربات عمداً از bot.ts (که handlerها را ثبت می‌کند) جدا است تا حلقه
// import ایجاد نشود: jobRunner برای فرستادن نتیجه به bot نیاز دارد، و bot برای
// شروع کار به jobRunner. هر دو از این فایل می‌گیرند و حلقه‌ای نمی‌ماند.
export const bot = new Bot(env.BOT_TOKEN, { client: { fetch: proxyFetch } });
