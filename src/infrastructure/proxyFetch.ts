import nodeFetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

// fetch داخلی Node متغیرهای HTTPS_PROXY/HTTP_PROXY را نادیده می‌گیرد (مگر با
// NODE_USE_ENV_PROXY=1 که باید قبل از شروع پروسه ست شود). چون سرویس‌هایی مثل
// Telegram و Gemini در بعضی مناطق نیاز به proxy دارند، اینجا صریحاً از
// node-fetch + HttpsProxyAgent استفاده می‌کنیم تا مستقل از نحوه‌ی اجرا کار کند.
// در production (VPS خارج از منطقه مسدود) این متغیرها ست نیستند و مستقیم وصل می‌شود.
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

export const proxyFetch = (proxyAgent
  ? (url: Parameters<typeof nodeFetch>[0], opts: Parameters<typeof nodeFetch>[1]) =>
      nodeFetch(url, { ...opts, agent: proxyAgent })
  : nodeFetch) as typeof nodeFetch;
