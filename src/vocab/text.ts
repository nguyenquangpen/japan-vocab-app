// Xử lý chữ thuần (không đụng DB) cho module vocab.

export const LIMITS = {
  term: 50,
  reading: 50,
  meaning: 100,
  meanings: 5,
  partOfSpeech: 50,
  usageNote: 500,
  userNote: 1000,
  meaningDetail: 1000,
  exampleText: 200,
  examples: 10,
} as const;

const KANA = /^[ぁ-ゖゝ-ゟァ-ヺー-ヿ]+$/;

/** NFKC + bỏ khoảng trắng thừa. Khoảng trắng toàn góc (U+3000) cũng thành khoảng trắng thường. */
export function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Chuỗi rỗng sau chuẩn hóa thành null. */
export function optionalText(value: string | null | undefined): string | null {
  const text = normalizeText(value ?? "");
  return text === "" ? null : text;
}

/** Như optionalText nhưng giữ xuống dòng (chỉ gộp khoảng trắng trong từng dòng, tối đa 1 dòng trống liền nhau). */
export function optionalMultiline(value: string | null | undefined): string | null {
  const text = (value ?? "")
    .normalize("NFKC")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === "" ? null : text;
}

export function isKana(value: string): boolean {
  return KANA.test(value);
}

/** "ăn, dùng bữa; xơi" → ["ăn", "dùng bữa", "xơi"] */
export function splitMeanings(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/[,;]/)
    .map(normalizeText)
    .filter((m) => m !== "");
}

export interface CleanWord {
  term: string;
  reading: string | null;
  meanings: string[];
  partOfSpeech: string | null;
  usageNote: string | null;
  userNote: string | null;
  meaningDetail: string | null;
}

export interface RawWord {
  term: string;
  reading?: string | null;
  meanings?: string[];
  partOfSpeech?: string | null;
  usageNote?: string | null;
  userNote?: string | null;
  meaningDetail?: string | null;
}

/** Chuẩn hóa và kiểm tra 1 từ. Trả về thông báo lỗi tiếng Việt nếu không hợp lệ. */
export function cleanWord(raw: RawWord): { ok: true; word: CleanWord } | { ok: false; message: string } {
  const term = normalizeText(raw.term);
  const reading = optionalText(raw.reading);
  const meanings = (raw.meanings ?? []).map(normalizeText).filter((m) => m !== "");
  const partOfSpeech = optionalText(raw.partOfSpeech);
  const usageNote = optionalText(raw.usageNote);
  const userNote = optionalText(raw.userNote);
  const meaningDetail = optionalMultiline(raw.meaningDetail);

  if (term === "") return { ok: false, message: "Chưa nhập từ." };
  if (term.length > LIMITS.term) return { ok: false, message: `Từ dài quá ${LIMITS.term} ký tự.` };
  if (reading !== null && !isKana(reading)) {
    return { ok: false, message: "Cách đọc chỉ gồm hiragana/katakana." };
  }
  if (reading !== null && reading.length > LIMITS.reading) {
    return { ok: false, message: `Cách đọc dài quá ${LIMITS.reading} ký tự.` };
  }
  if (meanings.length > LIMITS.meanings) {
    return { ok: false, message: `Tối đa ${LIMITS.meanings} nghĩa.` };
  }
  if (meanings.some((m) => m.length > LIMITS.meaning)) {
    return { ok: false, message: `Mỗi nghĩa tối đa ${LIMITS.meaning} ký tự.` };
  }
  if (partOfSpeech !== null && partOfSpeech.length > LIMITS.partOfSpeech) {
    return { ok: false, message: `Từ loại dài quá ${LIMITS.partOfSpeech} ký tự.` };
  }
  if (usageNote !== null && usageNote.length > LIMITS.usageNote) {
    return { ok: false, message: `Cách dùng dài quá ${LIMITS.usageNote} ký tự.` };
  }
  if (userNote !== null && userNote.length > LIMITS.userNote) {
    return { ok: false, message: `Ghi chú dài quá ${LIMITS.userNote} ký tự.` };
  }
  if (meaningDetail !== null && meaningDetail.length > LIMITS.meaningDetail) {
    return { ok: false, message: `Nghĩa mở rộng dài quá ${LIMITS.meaningDetail} ký tự.` };
  }
  return { ok: true, word: { term, reading, meanings, partOfSpeech, usageNote, userNote, meaningDetail } };
}

export interface CleanExample {
  ja: string;
  reading: string | null;
  vi: string | null;
}

/**
 * Chuẩn hóa và kiểm tra danh sách ví dụ. Dòng để trống hết thì bỏ qua;
 * có cách đọc/nghĩa mà thiếu câu tiếng Nhật thì báo lỗi.
 */
export function cleanExamples(
  raw: { ja: string; reading?: string | null; vi?: string | null }[],
): { ok: true; examples: CleanExample[] } | { ok: false; message: string } {
  const examples: CleanExample[] = [];
  for (const [index, e] of raw.entries()) {
    const ja = normalizeText(e.ja);
    const reading = optionalText(e.reading);
    const vi = optionalText(e.vi);
    if (ja === "" && reading === null && vi === null) continue;
    const n = index + 1;
    if (ja === "") return { ok: false, message: `Ví dụ thứ ${n} chưa có câu tiếng Nhật.` };
    if ([ja, reading ?? "", vi ?? ""].some((t) => t.length > LIMITS.exampleText)) {
      return { ok: false, message: `Ví dụ thứ ${n} dài quá ${LIMITS.exampleText} ký tự mỗi ô.` };
    }
    examples.push({ ja, reading, vi });
  }
  if (examples.length > LIMITS.examples) return { ok: false, message: `Tối đa ${LIMITS.examples} ví dụ.` };
  return { ok: true, examples };
}

/**
 * 1 dòng nhập hàng loạt → từ thô. Dạng hợp lệ:
 * `term`, `term reading`, `term | reading | nghĩa` (reading có thể để trống).
 * Trả về null nếu dòng trống.
 */
export function parseBatchLine(line: string): RawWord | { error: string } | null {
  const text = normalizeText(line);
  if (text === "") return null;

  if (text.includes("|")) {
    const parts = text.split("|").map((p) => p.trim());
    if (parts.length > 3) return { error: "Nhiều hơn 3 phần ngăn bởi |." };
    const [term, reading = "", meaning = ""] = parts;
    return { term, reading, meanings: splitMeanings(meaning) };
  }

  const tokens = text.split(" ");
  if (tokens.length > 2) {
    return { error: "Có nghĩa thì dùng dạng: từ | cách đọc | nghĩa." };
  }
  return { term: tokens[0], reading: tokens[1] ?? null };
}
