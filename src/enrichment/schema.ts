import { z } from "zod";
import { LIMITS, isKana } from "../vocab/text";

// Schema kiểm tra JSON dán từ ChatGPT (docs/design.md mục 5.5). Trường thừa bị bỏ qua.

// Không để zod thử tăng tốc bằng `new Function` (CSP chặn và CLAUDE.md cấm).
z.config({ jitless: true });

const text = (max: number, label: string) =>
  z.string({ error: `${label} phải là chuỗi.` }).max(max, { error: `${label} dài quá ${max} ký tự.` });

const reading = z
  .string({ error: "reading phải là chuỗi." })
  .max(LIMITS.reading, { error: `reading dài quá ${LIMITS.reading} ký tự.` })
  .refine((v) => v.trim() === "" || isKana(v.normalize("NFKC").trim()), {
    error: "reading chỉ được gồm hiragana/katakana/ー.",
  });

const example = z.object({
  ja: text(200, "examples.ja").min(1, { error: "examples.ja không được rỗng." }),
  reading: text(200, "examples.reading").optional(),
  vi: text(200, "examples.vi").optional(),
});

const confusable = z.object({
  term: text(30, "confusables.term").min(1, { error: "confusables.term không được rỗng." }),
  note: text(200, "confusables.note"),
});

const word = z.object({
  term: text(30, "term").min(1, { error: "term không được rỗng." }),
  reading: reading.optional(),
  meanings_vi: z
    .array(text(LIMITS.meaning, "meanings_vi"), { error: "meanings_vi phải là mảng chuỗi." })
    .min(1, { error: "meanings_vi cần ít nhất 1 nghĩa." })
    .max(LIMITS.meanings, { error: `meanings_vi tối đa ${LIMITS.meanings} nghĩa.` }),
  part_of_speech: text(LIMITS.partOfSpeech, "part_of_speech").optional(),
  examples: z.array(example, { error: "examples phải là mảng." }).max(3, { error: "examples tối đa 3 câu." }).default([]),
  usage_note: text(LIMITS.usageNote, "usage_note").optional(),
  confusables: z
    .array(confusable, { error: "confusables phải là mảng." })
    .max(3, { error: "confusables tối đa 3 từ." })
    .default([]),
});

export const enrichResponseSchema = z.object({
  words: z
    .array(word, { error: "Thiếu mảng words." })
    .min(1, { error: "words không có từ nào." })
    .max(50, { error: "words tối đa 50 từ." }),
});

export type EnrichResponse = z.infer<typeof enrichResponseSchema>;
export type EnrichItem = EnrichResponse["words"][number];
