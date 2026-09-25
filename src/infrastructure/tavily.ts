import { env } from "../config/env.js";
import { proxyFetch } from "./proxyFetch.js";

const SEARCH_URL = "https://api.tavily.com/search";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export class TavilyError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "TavilyError";
  }
}

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
}

// fallback جستجو وقتی grounding گوگل در دسترس نیست (docs/TECH-SPEC.md §۵).
// عمداً بدون حلقه retry: این خودش مسیر پشتیبان است و صداکننده (services/evidence.ts)
// تصمیم می‌گیرد شکست آن یعنی چه.
export async function tavilySearch(query: string, maxResults = 6): Promise<TavilyResult[]> {
  if (!env.TAVILY_API_KEY) {
    throw new TavilyError("TAVILY_API_KEY تنظیم نشده است");
  }

  let res;
  try {
    res = await proxyFetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: "basic",
      }),
    });
  } catch (err) {
    throw new TavilyError(`خطای شبکه در تماس با Tavily: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new TavilyError(`Tavily با کد ${res.status} پاسخ داد: ${text.slice(0, 300)}`, res.status);
  }

  const json = (await res.json()) as TavilyResponse;

  return (json.results ?? [])
    .filter((item): item is Required<Pick<typeof item, "title" | "url">> & typeof item =>
      Boolean(item.url && item.title)
    )
    .map((item) => ({
      title: item.title,
      url: item.url,
      content: item.content ?? "",
      score: item.score ?? 0,
    }));
}
