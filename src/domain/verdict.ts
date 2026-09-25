import { z } from "zod";

// طبق docs/TECH-SPEC.md بخش ۳ (قرارداد خروجی Stage 2)
export const VerdictStatusSchema = z.enum([
  "تأیید",
  "رد",
  "نیازمند بررسی",
  "غیرقابل راستی‌آزمایی",
  "هنوز قابل راستی‌آزمایی نیست",
]);
export type VerdictStatus = z.infer<typeof VerdictStatusSchema>;

export const SourceSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  publisher: z.string().optional(),
  published_at: z.string().optional(),
});
export type Source = z.infer<typeof SourceSchema>;

export const VerdictSchema = z.object({
  status: VerdictStatusSchema,
  confidence: z.number().min(0).max(100),
  summary: z.string(),
  evidence_points: z.array(z.string()).default([]),
  sources: z.array(SourceSchema).default([]),
  limitations: z.array(z.string()).default([]),
  disclaimer: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

// طبق docs/TECH-SPEC.md بخش ۴
export const STATUS_EMOJI: Record<VerdictStatus, string> = {
  "تأیید": "🟢",
  "رد": "🔴",
  "نیازمند بررسی": "🟡",
  "غیرقابل راستی‌آزمایی": "⚪",
  "هنوز قابل راستی‌آزمایی نیست": "⏳",
};

// disclaimer «ثابت» یعنی مستقل از خروجی مدل همیشه همین متن نمایش داده می‌شود
// (هرگز به فیلد disclaimer برگردانده‌شده توسط مدل اعتماد نمی‌کنیم).
export const FIXED_DISCLAIMER = "این پاسخ جایگزین بررسی انسانی یا مشاوره تخصصی نیست.";
