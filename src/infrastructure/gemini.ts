import { env } from "../config/env.js";
import { log } from "./logger.js";
import { proxyFetch } from "./proxyFetch.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// زیرمجموعه‌ای از JSON Schema که Gemini برای structured output می‌پذیرد.
export interface GeminiJsonSchema {
  type: "OBJECT" | "ARRAY" | "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN";
  properties?: Record<string, GeminiJsonSchema>;
  items?: GeminiJsonSchema;
  required?: string[];
  enum?: string[];
  description?: string;
  nullable?: boolean;
}

export interface GenerateOptions {
  model: string;
  systemInstruction: string;
  userContent: string;
  responseSchema?: GeminiJsonSchema;
  temperature?: number;
  // ⚠️ نمی‌توان همزمان با responseSchema استفاده کرد. تست واقعی روی API خطای
  // ۴۰۰ داد: "Tool use with a response mime type: 'application/json' is
  // unsupported". برای همین Stage 2 دو تماس جدا دارد: اول grounding (متن آزاد)،
  // بعد structuring (JSON بدون tool).
  useGoogleSearchGrounding?: boolean;
}

// بخشی از پاسخ که وقتی grounding فعال است منابع واقعی جستجو را برمی‌گرداند.
export interface GroundingChunk {
  web?: { uri: string; title: string };
}

export interface GroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: GroundingChunk[];
}

export interface GenerateResult {
  text: string;
  groundingMetadata?: GroundingMetadata;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    groundingMetadata?: GroundingMetadata;
  }>;
  promptFeedback?: { blockReason?: string };
}

// طبق docs/TECH-SPEC.md بخش ۶:
// - transient error (5xx / شبکه): تا ۳ retry
// - rate limit (429): backoff با jitter
// - 4xx قطعی: بدون retry
const MAX_ATTEMPTS = 3;

function backoffDelayMs(attempt: number): number {
  const base = 500 * 2 ** (attempt - 1); // 500، 1000، 2000
  const jitter = Math.random() * 250;
  return base + jitter;
}

async function callOnce(options: GenerateOptions): Promise<GenerateResult> {
  const url = `${BASE_URL}/${options.model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: options.systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: options.userContent }] }],
    generationConfig: {
      temperature: options.temperature ?? 0,
      ...(options.responseSchema
        ? { responseMimeType: "application/json", responseSchema: options.responseSchema }
        : {}),
    },
    ...(options.useGoogleSearchGrounding ? { tools: [{ google_search: {} }] } : {}),
  };

  let res;
  try {
    res = await proxyFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // خطای شبکه — قابل retry
    throw new GeminiError(`خطای شبکه در تماس با Gemini: ${(err as Error).message}`, undefined, true);
  }

  if (!res.ok) {
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    throw new GeminiError(
      `Gemini با کد ${res.status} پاسخ داد: ${text.slice(0, 300)}`,
      res.status,
      retryable
    );
  }

  const json = (await res.json()) as GeminiResponse;

  if (json.promptFeedback?.blockReason) {
    throw new GeminiError(`Gemini درخواست را بلاک کرد: ${json.promptFeedback.blockReason}`);
  }

  const candidate = json.candidates?.[0];

  // در پاسخ‌های grounded متن معمولاً بین چند part تقسیم می‌شود، پس همه را به هم
  // می‌چسبانیم؛ خواندن فقط parts[0] بخشی از جواب را از دست می‌داد.
  const text = candidate?.content?.parts
    ?.map((part) => part.text)
    .filter((value): value is string => Boolean(value))
    .join("");

  if (!text) {
    throw new GeminiError(
      `پاسخ Gemini متن نداشت (finishReason: ${candidate?.finishReason ?? "نامشخص"})`
    );
  }

  return { text, groundingMetadata: candidate?.groundingMetadata };
}

export async function generateContentFull(options: GenerateOptions): Promise<GenerateResult> {
  let lastError: GeminiError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callOnce(options);
    } catch (err) {
      const geminiErr =
        err instanceof GeminiError ? err : new GeminiError(String(err), undefined, false);
      lastError = geminiErr;

      if (!geminiErr.retryable || attempt === MAX_ATTEMPTS) {
        throw geminiErr;
      }

      const delay = backoffDelayMs(attempt);
      log.warn(
        `⚠️ تلاش ${attempt}/${MAX_ATTEMPTS} برای Gemini شکست خورد (${geminiErr.message.slice(0, 120)})؛ ${Math.round(delay)}ms صبر می‌کنم...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new GeminiError("تماس با Gemini بدون دلیل مشخص شکست خورد");
}

export async function generateContent(options: GenerateOptions): Promise<string> {
  const result = await generateContentFull(options);
  return result.text;
}

// ═══════════════════════════════════════════════════════════════════
// Embeddings (Task 8 — کش معنایی)
// ═══════════════════════════════════════════════════════════════════

interface EmbedResponse {
  embedding?: { values?: number[] };
}

const EMBEDDING_DIMENSIONS = 768; // باید با ستون vector(768) در دیتابیس بخواند

// بردار خروجی به طول واحد برگردانده می‌شود.
//
// ⚠️ چرا لازم است: مدل‌های embedding جمنای به‌صورت پیش‌فرض ۳۰۷۲ بعدی‌اند و وقتی
// با outputDimensionality کوتاه‌شان می‌کنیم، خروجی دیگر نرمال نیست (در تست واقعی
// طول بردار ۷۶۸بعدیِ gemini-embedding-001 برابر ۰.۵۹۹ بود، نه ۱). برای فاصله‌ی
// کسینوسی که خودش بر طول تقسیم می‌کند فرقی نمی‌کند، ولی بردارهای ذخیره‌شده را
// ناهمگون می‌کند و اگر روزی به فاصله‌ی L2 یا ضرب داخلی سوئیچ کنیم بی‌صدا خراب
// می‌شود. نرمال‌سازی اینجا این ریسک را از بین می‌برد.
function normalizeVector(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0 || !Number.isFinite(norm)) return values;
  return values.map((x) => x / norm);
}

async function embedOnce(text: string): Promise<number[]> {
  const url = `${BASE_URL}/${env.GEMINI_MODEL_EMBEDDING}:embedContent?key=${env.GEMINI_API_KEY}`;

  let res;
  try {
    res = await proxyFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        // بدون این، خروجی ۳۰۷۲ بعدی است و در ستون vector(768) جا نمی‌شود.
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    });
  } catch (err) {
    throw new GeminiError(
      `خطای شبکه در تماس embedding: ${(err as Error).message}`,
      undefined,
      true
    );
  }

  if (!res.ok) {
    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    throw new GeminiError(
      `embedding با کد ${res.status} پاسخ داد: ${body.slice(0, 300)}`,
      res.status,
      retryable
    );
  }

  const json = (await res.json()) as EmbedResponse;
  const values = json.embedding?.values;

  if (!values?.length) {
    throw new GeminiError("پاسخ embedding بردار نداشت");
  }
  // اگر مدل عوض شود و ابعادش فرق کند، درج در ستون vector(768) خطا می‌دهد؛
  // بهتر است همین‌جا با پیام روشن شکست بخورد تا در لایه دیتابیس.
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new GeminiError(
      `بردار ${values.length} بعدی است ولی ستون دیتابیس ${EMBEDDING_DIMENSIONS} بعدی است ` +
        `(GEMINI_MODEL_EMBEDDING=${env.GEMINI_MODEL_EMBEDDING})`
    );
  }

  return normalizeVector(values);
}

/** بردار معنایی متن — برای مسیر «تیتر مشابه» در cache. */
export async function embedContent(text: string): Promise<number[]> {
  let lastError: GeminiError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await embedOnce(text);
    } catch (err) {
      const geminiErr =
        err instanceof GeminiError ? err : new GeminiError(String(err), undefined, false);
      lastError = geminiErr;

      if (!geminiErr.retryable || attempt === MAX_ATTEMPTS) throw geminiErr;

      const delay = backoffDelayMs(attempt);
      log.warn(
        `⚠️ تلاش ${attempt}/${MAX_ATTEMPTS} برای embedding شکست خورد؛ ${Math.round(delay)}ms صبر می‌کنم...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new GeminiError("تماس embedding بدون دلیل مشخص شکست خورد");
}
