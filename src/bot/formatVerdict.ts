import { FIXED_DISCLAIMER, STATUS_EMOJI, type Verdict } from "../domain/verdict.js";

// طبق مستندات Telegram: این کاراکترها در MarkdownV2 باید escape شوند.
const MARKDOWNV2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function escapeText(text: string): string {
  return text.replace(MARKDOWNV2_SPECIAL_CHARS, (ch) => `\\${ch}`);
}

// داخل `(URL)` فقط `)` و `\` نیاز به escape دارند.
function escapeUrl(url: string): string {
  return url.replace(/[)\\]/g, (ch) => `\\${ch}`);
}

// طبق docs/TECH-SPEC.md بخش ۴ (قالب پیام به کاربر).
// خروجی MarkdownV2 است؛ همه‌ی متن‌های پویا escape می‌شوند تا هم فرمت خراب نشود
// و هم متن مدل نتواند markdown دلخواه تزریق کند.
export function formatVerdictMessage(verdict: Verdict): string {
  const emoji = STATUS_EMOJI[verdict.status];
  const confidence = Math.round(verdict.confidence);

  const lines = [`*${emoji} ${escapeText(verdict.status)}*`, "", `*خلاصه:* ${escapeText(verdict.summary)}`, "", `*اعتماد:* ${confidence}٪`];

  if (verdict.evidence_points.length > 0) {
    lines.push("", "*شواهد:*");
    for (const point of verdict.evidence_points) {
      lines.push(`\\- ${escapeText(point)}`);
    }
  }

  if (verdict.sources.length > 0) {
    lines.push("", "*منابع:*");
    verdict.sources.forEach((source, index) => {
      lines.push(`${index + 1}\\) [${escapeText(source.title)}](${escapeUrl(source.url)})`);
    });
  }

  lines.push("", `⚠️ ${escapeText(FIXED_DISCLAIMER)}`);

  return lines.join("\n");
}
