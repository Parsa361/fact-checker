import type { Context } from "grammy";
import type { MessageEntity } from "grammy/types";
import { env } from "../config/env.js";
import {
  formatGroupQuotaExceeded,
  formatQuotaExceeded,
  JOB_ABANDONED_MESSAGE,
  RATE_LIMIT_MESSAGES,
} from "../domain/rateLimit.js";
import { sanitizeInputText } from "../domain/sanitize.js";
import { log, redactClaim } from "../infrastructure/logger.js";
import { apologizeForJob, dispatchJob } from "../services/jobRunner.js";
import {
  markJobReady,
  reserveCheckSlot,
  finalizeJobFailure,
  upsertGroupAuthorization,
} from "../services/rateLimit.js";
import { bot } from "./instance.js";
// وارد کردن این ماژول /stats را ثبت می‌کند. باید «قبل از» handler عمومی
// message:text بیاید، وگرنه grammY هر دستور را به‌عنوان یک ادعا راستی‌آزمایی
// می‌کند (سهمیه و چند تماس جمنای برای هیچ).
import "./stats.js";

// وارد کردن این ماژول، handlerها را روی instance ثبت می‌کند.
export { bot };

// شرطی که هر سه نقطه‌ی ورود (پیام مستقیم، mention گروهی، /check) باید داشته باشند.
type ClaimTrigger = Context & {
  message: NonNullable<Context["message"]>;
  from: NonNullable<Context["from"]>;
  chat: NonNullable<Context["chat"]>;
};

/** entity منشن ربات را در متن پیدا می‌کند (برای تشخیص «@نام‌ربات» در گروه). */
function findBotMention(text: string, entities: MessageEntity[] | undefined): MessageEntity | undefined {
  const botUsername = `@${bot.botInfo.username}`.toLowerCase();
  return entities?.find(
    (e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === botUsername
  );
}

/** متن پیام را بدون substring منشن برمی‌گرداند (برای حالت inline). */
function stripMention(text: string, mention: MessageEntity): string {
  return (text.slice(0, mention.offset) + text.slice(mention.offset + mention.length)).trim();
}

/**
 * منطق مشترک هر سه نقطه‌ی ورود claim: sanitize، رزرو سهمیه، پیام «⏳»، dispatch.
 * `replyToMessageId` جایی است که پاسخ‌ها به آن ریپلای می‌شوند — در حالت گروهی
 * این پیامِ اصلیِ ادعا است، نه پیامی که ربات را صدا زده.
 */
async function processClaim(
  ctx: ClaimTrigger,
  rawText: string,
  replyToMessageId: number
): Promise<void> {
  const claimText = sanitizeInputText(rawText, env.MAX_INPUT_CHARS);

  if (claimText.length === 0) {
    await ctx.reply("متن پیام شما خالی به‌نظر می‌رسد. لطفاً یک متن، تیتر یا ادعای واقعی بفرستید.", {
      reply_parameters: { message_id: replyToMessageId },
    });
    return;
  }

  // ⚠️ بررسی محدودیت «قبل از» ارسال پیام «⏳» انجام می‌شود: وقتی کاربر سهمیه‌اش
  // تمام شده، این مسیر پرتکرارترین حالت می‌شود؛ فرستادن ⏳ و بلافاصله ویرایش آن
  // یعنی دو تماس API و یک چشمک آزاردهنده برای پاسخی که فوری و قطعی است.
  const isGroup = ctx.chat.type !== "private";
  const reservation = await reserveCheckSlot({
    telegramId: ctx.from.id,
    username: ctx.from.username,
    chatId: ctx.chat.id,
    sourceMessageId: ctx.message.message_id,
    claimText,
    isGroup,
    chatTitle: "title" in ctx.chat ? ctx.chat.title : undefined,
  });

  // کارهای گیرکرده‌ای که همین فراخوانی آزادشان کرد: پیام «⏳» معلقشان را با
  // عذرخواهی جایگزین کن تا کاربر تا ابد منتظر نماند.
  for (const reaped of reservation.reaped) {
    void apologizeForJob(reaped, JOB_ABANDONED_MESSAGE);
  }

  if (!reservation.allowed) {
    // تحویل تکراری webhook — کاربر قبلاً پاسخ گرفته یا در حال گرفتن است.
    if (reservation.reason === "duplicate_delivery") return;

    let message: string;
    if (reservation.reason === "quota_exceeded") {
      message = formatQuotaExceeded(reservation.reset_at, env.DAILY_FREE_CHECK_LIMIT);
    } else if (reservation.reason === "group_quota_exceeded") {
      message = formatGroupQuotaExceeded(reservation.reset_at, env.GROUP_DAILY_CHECK_LIMIT);
    } else {
      message = RATE_LIMIT_MESSAGES[reservation.reason];
    }
    log.info(`🚫 رد شد از ${ctx.from.id}: ${reservation.reason}`);
    await ctx.reply(message, { reply_parameters: { message_id: replyToMessageId } });

    if (reservation.reason === "group_not_authorized") {
      // به‌طور معمول نباید اینجا برسیم — my_chat_member باید همان لحظه‌ی join
      // خارج شده باشد. اگر رسیدیم (race یا شکست قبلیِ leaveChat)، همین‌جا هم ترک کن.
      log.error(`⚠️ گروه ${ctx.chat.id} مجوز نداشت ولی my_chat_member جلویش را نگرفته بود.`);
      await ctx.api.leaveChat(ctx.chat.id).catch((err) => log.error("❌ leaveChat شکست خورد:", err));
    }
    return;
  }

  log.info(
    `📩 پیام از ${ctx.from.id} (سهمیه ${reservation.quota_used}/${reservation.quota_limit}) ` +
      `job=${reservation.job_id.slice(0, 8)}: ${redactClaim(claimText)}`
  );

  // reply_to چون حالا پاسخ‌ها ممکن است با تأخیر و خارج از ترتیب برسند.
  let statusMessage;
  try {
    statusMessage = await ctx.reply("⏳ در حال بررسی...", {
      reply_parameters: { message_id: replyToMessageId },
    });
  } catch (err) {
    // نتوانستیم «⏳» بفرستیم؛ job را terminal کن تا سهمیه برگردد و ردیف یتیم نماند.
    log.error("❌ ارسال پیام وضعیت شکست خورد:", err);
    await finalizeJobFailure(reservation.job_id, "failed to send status message");
    return;
  }

  // reserved → pending. تا این لحظه job قابل برداشت نبود، پس امکان ندارد
  // worker قبل از ثبت status_message_id تمام شود.
  const ready = await markJobReady(reservation.job_id, statusMessage.message_id);
  if (!ready) {
    await finalizeJobFailure(reservation.job_id, "mark_job_ready failed");
    return;
  }

  dispatchJob(reservation.job_id);
  // handler همین‌جا برمی‌گردد (~۲۵۰ms) — پردازش در صف ادامه پیدا می‌کند.
}

// فقط ادمین می‌تواند ربات را به گروه اضافه کند. این رویداد وقتی وضعیت عضویت
// «خودِ ربات» در یک چت تغییر می‌کند فایر می‌شود (اضافه/حذف/ارتقا/تنزل). چون فقط
// همین‌جا مشخص است چه کسی ربات را اضافه کرده، تصمیم ماندن/ترک‌کردن اینجا گرفته
// می‌شود — reserve_check_slot در processClaim فقط دفاع لایه‌ی دوم است.
bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.myChatMember.chat;
  if (chat.type === "private") return;

  const oldStatus = ctx.myChatMember.old_chat_member.status;
  const newStatus = ctx.myChatMember.new_chat_member.status;
  // فقط «تازه اضافه شدن» را می‌سنجیم، نه ارتقا/تنزل بین member و administrator —
  // آن انتقال‌ها نباید مجوزی که موقع join تعیین شد را دوباره ارزیابی کنند.
  const justJoined =
    (oldStatus === "left" || oldStatus === "kicked") &&
    (newStatus === "member" || newStatus === "administrator");
  if (!justJoined) return;

  const adder = ctx.myChatMember.from;
  const isAdmin = env.ADMIN_TELEGRAM_IDS.includes(adder.id);

  await upsertGroupAuthorization({
    chatId: chat.id,
    title: "title" in chat ? chat.title : undefined,
    authorized: isAdmin,
    authorizedBy: adder.id,
  });

  if (!isAdmin) {
    log.warn(`⛔ ${adder.id} (غیرادمین) ربات را به گروه ${chat.id} اضافه کرد؛ در حال خروج.`);
    try {
      await ctx.api.sendMessage(
        chat.id,
        "این ربات فقط توسط سازنده آن قابل افزودن به گروه است. در حال خروج از این گروه هستم."
      );
    } catch {
      // اگر همین پیام هم نرسد مهم نیست؛ leaveChat در هر حال اجرا می‌شود.
    }
    await ctx.api.leaveChat(chat.id).catch((err) => log.error("❌ leaveChat شکست خورد:", err));
    return;
  }

  log.info(`✅ ${adder.id} (ادمین) ربات را به گروه ${chat.id} اضافه کرد.`);
  await ctx.api.sendMessage(
    chat.id,
    "سلام! برای راستی‌آزمایی از دستور /check استفاده کنید:\n" +
      "• /check ادعای موردنظر\n" +
      "• یا روی پیامی ریپلای کنید و فقط /check بفرستید"
  );
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "سلام! متن، تیتر یا خبری که می‌خواهید راستی‌آزمایی شود را برای من فوروارد یا ارسال کنید.\n\n" +
      "در گروه‌ها با دستور /check کار می‌کنم:\n" +
      "• /check ادعای موردنظر — برای بررسی یک متن تازه\n" +
      "• روی پیامی ریپلای کنید و فقط /check بفرستید"
  );
});

// دستور گروهی. برخلاف منشن، دستورها را تلگرام «همیشه» تحویل می‌دهد — حتی وقتی
// Group Privacy روشن است. پس این مسیر تنها راهی است که بدون خاموش کردن privacy
// در گروه کار می‌کند، و به همین دلیل هر دو حالت را پشتیبانی می‌کند:
//   /check            روی یک ریپلای  → متن پیام ریپلای‌شده
//   /check <ادعا>     به‌عنوان پیام تازه → همان متنِ بعد از دستور
//
// وقتی هر دو باشند (ریپلای + متن بعد از دستور)، ریپلای برنده است — همان قاعده‌ای
// که مسیر منشن دارد، تا رفتار بین دو مسیر یکسان بماند.
//
// ⚠️ یافته‌ی تست واقعی: در گروه‌های «ساده» (legacy، نه supergroup) با Privacy
// Mode روشن، تلگرام فیلد reply_to_message را اصلاً به ربات تحویل نمی‌دهد — حتی
// وقتی کاربر واقعاً و به‌درستی ریپلای زده و در کلاینت هم نوار پیش‌نمایش دیده
// می‌شود. در supergroup این محدودیت وجود ندارد. راه‌حلی سمت کد ندارد چون داده
// اصلاً به Node نمی‌رسد؛ تنها راه، تبدیل گروه به supergroup است (مثلاً با روشن
// کردن «Chat history for new members» یا گذاشتن لینک عمومی).
bot.command("check", async (ctx) => {
  if (!ctx.message) return; // فقط پیام متنی (نه channel post)

  const replied = ctx.message.reply_to_message;
  if (replied) {
    if (!replied.text) {
      await ctx.reply("پیامی که ریپلای کرده‌اید متن ندارد؛ من فقط می‌توانم متن را بررسی کنم.", {
        reply_parameters: { message_id: replied.message_id },
      });
      return;
    }
    await processClaim(ctx, replied.text, replied.message_id);
    return;
  }

  const inlineClaim = ctx.match?.toString().trim() ?? "";
  if (inlineClaim.length === 0) {
    await ctx.reply(
      "ادعا را بعد از دستور بنویسید (مثلاً «/check مصرف زیاد نمک باعث فشار خون بالا می‌شود»)،" +
        " یا این دستور را روی پیامی که می‌خواهید بررسی شود ریپلای کنید.",
      { reply_parameters: { message_id: ctx.message.message_id } }
    );
    return;
  }
  await processClaim(ctx, inlineClaim, ctx.message.message_id);
});

// هر دستور ناشناخته‌ای که به اینجا برسد، وگرنه handler پایین آن را به‌عنوان
// «ادعا» راستی‌آزمایی می‌کند و یک واحد از سهمیه‌ی کاربر را می‌خورد.
bot.on("message:entities:bot_command", async (ctx) => {
  await ctx.reply("این دستور را نمی‌شناسم. برای راستی‌آزمایی، متن یا خبر را مستقیم بفرستید.");
});

bot.on("message:text", async (ctx) => {
  // چت خصوصی: کل پیام یک ادعاست، رفتار همیشگی.
  if (ctx.chat.type === "private") {
    await processClaim(ctx, ctx.message.text, ctx.message.message_id);
    return;
  }

  // گروه. ⚠️ یافته‌ی تست واقعی: با Group Privacy روشن (که تصمیم محصول است)،
  // تلگرام منشن ساده را «تحویل نمی‌دهد» — فقط دستورها و ریپلای‌به‌ربات می‌رسند.
  // پس رابط اصلی گروه دستور /check است و این مسیر عملاً فقط وقتی زنده می‌شود که
  // privacy خاموش شود یا ربات در گروه ادمین شود.
  //
  // با این حال این گیت حذف نشده و لازم است: ریپلای‌به‌ربات «همیشه» می‌رسد، پس
  // بدون آن هر «باشه»/«مرسی» که کسی زیر پاسخ ربات بنویسد یک بررسی کامل
  // (سهمیه + سه تماس جمنای) خرج می‌کرد.
  const mention = findBotMention(ctx.message.text, ctx.message.entities);
  if (!mention) return;

  const replied = ctx.message.reply_to_message;
  if (replied) {
    // حالت «ریپلای + منشن»: متن پیامِ ریپلای‌شده بررسی می‌شود، نه متنی که
    // همراه منشن نوشته شده.
    if (!replied.text) {
      await ctx.reply("پیامی که ریپلای کرده‌اید متن ندارد؛ من فقط می‌توانم متن را بررسی کنم.", {
        reply_parameters: { message_id: replied.message_id },
      });
      return;
    }
    await processClaim(ctx, replied.text, replied.message_id);
    return;
  }

  // حالت inline: ادعا همان متنی است که بعد از منشن نوشته شده.
  const inlineClaim = stripMention(ctx.message.text, mention);
  if (inlineClaim.length === 0) {
    await ctx.reply(
      "بعد از منشن‌کردن من، ادعایی که می‌خواهید بررسی شود را بنویسید؛ یا روی پیامی که می‌خواهید" +
        " بررسی شود ریپلای کنید و من را منشن کنید.",
      { reply_parameters: { message_id: ctx.message.message_id } }
    );
    return;
  }
  await processClaim(ctx, inlineClaim, ctx.message.message_id);
});

// طبق docs/SECURITY.md بخش ۵: در فاز اول attachment (عکس، صدا، فایل و ...) پردازش نمی‌شود.
// در گروه فقط وقتی جواب می‌دهیم که ربات صراحتاً منشن شده باشد، وگرنه سکوت
// (privacy mode معمولاً همین را تضمین می‌کند؛ این هم یک لایه‌ی دفاعی است).
bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") {
    const mention = findBotMention(ctx.message.caption ?? "", ctx.message.caption_entities);
    if (!mention) return;
    await ctx.reply("فعلاً فقط پیام متنی پشتیبانی می‌شود. لطفاً متن، تیتر یا ادعا را مستقیم بفرستید.", {
      reply_parameters: { message_id: ctx.message.message_id },
    });
    return;
  }
  await ctx.reply("فعلاً فقط پیام متنی پشتیبانی می‌شود. لطفاً متن، تیتر یا ادعا را مستقیم بفرستید.");
});

// ⚠️ این فقط فاز handler را پوشش می‌دهد. چون dispatch عمداً fire-and-forget است،
// خطاهای داخل job هرگز به اینجا نمی‌رسند؛ try/catch خود runJob تنها تور آن‌هاست.
bot.catch((err) => {
  log.error("خطای ربات:", err);
});
