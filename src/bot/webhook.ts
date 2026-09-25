import { createServer } from "node:http";
import { webhookCallback } from "grammy";
import { bot } from "./bot.js";
import { env } from "../config/env.js";

const WEBHOOK_PATH = "/telegram-webhook";

export async function startWebhookServer() {
  if (!env.PUBLIC_BASE_URL || !env.WEBHOOK_SECRET) {
    throw new Error("PUBLIC_BASE_URL و WEBHOOK_SECRET برای حالت webhook الزامی‌اند");
  }

  await bot.init();

  const handleUpdate = webhookCallback(bot, "http", {
    secretToken: env.WEBHOOK_SECRET,
  });

  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      await handleUpdate(req, res);
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(env.PORT, () => {
    console.log(`🌐 سرور webhook روی پورت ${env.PORT} در حال گوش دادن است.`);
  });

  await bot.api.setWebhook(`${env.PUBLIC_BASE_URL}${WEBHOOK_PATH}`, {
    secret_token: env.WEBHOOK_SECRET,
  });
  console.log(`🤖 ربات @${bot.botInfo.username} در حالت webhook فعال شد.`);

  return server;
}
