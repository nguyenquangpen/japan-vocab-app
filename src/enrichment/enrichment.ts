import { normalizeText } from "../vocab/text";
import type { EnrichmentData, WordDetail } from "../vocab/vocab";
import { enrichResponseSchema, type EnrichItem } from "./schema";

// Luồng copy–paste bổ sung từ (docs/design.md mục 5.1). Toàn hàm thuần, không đụng DB.

export type { EnrichItem } from "./schema";

/** Số từ tối đa mỗi lô gửi ChatGPT. */
export const MAX_BATCH = 30;

export function buildEnrichPrompt(terms: string[], level: string): string {
  return `Bạn là giáo viên tiếng Nhật cho người Việt, trình độ học viên: ${level}.
Với mỗi từ dưới đây, trả về thông tin theo đúng định dạng JSON ở cuối.
Yêu cầu:
- reading: chỉ dùng hiragana (katakana nếu là từ ngoại lai).
- meanings_vi: 1–3 nghĩa tiếng Việt ngắn gọn, nghĩa phổ biến nhất đứng đầu.
- examples: 2 câu ví dụ ngắn, ngữ pháp không vượt quá trình độ ${level}.
- usage_note: 1–2 câu về cách dùng, sắc thái.
- confusables: tối đa 2 từ dễ nhầm, kèm 1 câu phân biệt. Không có thì để [].
Chỉ trả về JSON, không giải thích thêm, không dùng markdown.

Danh sách từ:
${terms.join("\n")}

Định dạng:
{"words":[{"term":"","reading":"","meanings_vi":[""],"part_of_speech":"","examples":[{"ja":"","reading":"","vi":""}],"usage_note":"","confusables":[{"term":"","note":""}]}]}`;
}

export interface BatchWord {
  id: number;
  term: string;
  reading: string | null;
}

export type ParseResult =
  | {
      ok: true;
      matches: { wordId: number; item: EnrichItem }[];
      /** Term AI trả về nhưng không có trong lô. */
      unmatched: string[];
      /** Từ trong lô mà AI không trả về. */
      missing: string[];
    }
  | { ok: false; message: string };

/** Đọc nội dung dán từ ChatGPT, kiểm tra schema, ghép với các từ trong lô theo term. */
export function parseEnrichResponse(text: string, batch: BatchWord[]): ParseResult {
  const json = extractJson(text);
  if (json === null) return { ok: false, message: "Không tìm thấy JSON trong nội dung dán vào." };

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, message: "JSON bị lỗi cú pháp (có thể bị cắt mất hoặc thừa ký tự). Hãy copy lại toàn bộ kết quả." };
  }

  const parsed = enrichResponseSchema.safeParse(data);
  if (!parsed.success) return { ok: false, message: formatIssues(parsed.error.issues, data) };

  const matched = new Set<number>();
  const matches: { wordId: number; item: EnrichItem }[] = [];
  const unmatched: string[] = [];

  for (const item of parsed.data.words) {
    const term = normalizeText(item.term);
    const reading = normalizeText(item.reading ?? "");
    const candidates = batch.filter((w) => !matched.has(w.id) && w.term === term);
    const pick =
      candidates.length === 1
        ? candidates[0]
        : (candidates.find((w) => w.reading === reading) ?? candidates.find((w) => w.reading === null));
    if (!pick) {
      unmatched.push(item.term);
      continue;
    }
    matched.add(pick.id);
    matches.push({ wordId: pick.id, item });
  }

  const missing = batch.filter((w) => !matched.has(w.id)).map((w) => w.term);
  return { ok: true, matches, unmatched, missing };
}

export type FieldKey = "reading" | "meanings" | "partOfSpeech" | "usageNote" | "examples" | "confusables";

export interface FieldPreview {
  key: FieldKey;
  label: string;
  current: string;
  suggested: string;
  /** Mặc định dùng gợi ý AI khi trường hiện tại đang trống. */
  useSuggestedByDefault: boolean;
}

const LABELS: Record<FieldKey, string> = {
  reading: "Cách đọc",
  meanings: "Nghĩa",
  partOfSpeech: "Từ loại",
  usageNote: "Cách dùng",
  examples: "Ví dụ",
  confusables: "Từ dễ nhầm",
};

/** Các trường AI có gợi ý khác với hiện tại, dạng chữ để hiển thị. */
export function previewFields(word: WordDetail, item: EnrichItem): FieldPreview[] {
  const current = displayValues(fromWord(word));
  const suggested = displayValues(fromItem(item));
  return (Object.keys(LABELS) as FieldKey[])
    .filter((key) => suggested[key] !== "" && suggested[key] !== current[key])
    .map((key) => ({
      key,
      label: LABELS[key],
      current: current[key],
      suggested: suggested[key],
      useSuggestedByDefault: current[key] === "",
    }));
}

/** Ghép giá trị cuối cùng: trường được chọn lấy của AI, còn lại giữ như cũ. */
export function mergeEnrichment(
  word: WordDetail,
  item: EnrichItem,
  useSuggested: ReadonlySet<FieldKey>,
): EnrichmentData {
  const mine = fromWord(word);
  const ai = fromItem(item);
  const pick = <K extends FieldKey>(key: K) => (useSuggested.has(key) ? ai[key] : mine[key]);
  return {
    reading: pick("reading"),
    meanings: pick("meanings"),
    partOfSpeech: pick("partOfSpeech"),
    usageNote: pick("usageNote"),
    confusables: pick("confusables"),
    examples: useSuggested.has("examples") ? ai.examples : null,
  };
}

type Fields = Omit<EnrichmentData, "examples"> & { examples: NonNullable<EnrichmentData["examples"]> };

function fromWord(word: WordDetail): Fields {
  return {
    reading: word.reading,
    meanings: word.meanings,
    partOfSpeech: word.partOfSpeech,
    usageNote: word.usageNote,
    confusables: word.confusables,
    examples: word.examples.map(({ ja, reading, vi }) => ({ ja, reading, vi })),
  };
}

function fromItem(item: EnrichItem): Fields {
  const orNull = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : v.trim());
  return {
    reading: orNull(item.reading),
    meanings: item.meanings_vi.map((m) => m.trim()).filter((m) => m !== ""),
    partOfSpeech: orNull(item.part_of_speech),
    usageNote: orNull(item.usage_note),
    confusables: item.confusables,
    examples: item.examples.map((e) => ({ ja: e.ja, reading: orNull(e.reading), vi: orNull(e.vi) })),
  };
}

function displayValues(f: Fields): Record<FieldKey, string> {
  const show = (v: string | null) => normalizeText(v ?? "");
  return {
    reading: show(f.reading),
    meanings: f.meanings.map(show).join("; "),
    partOfSpeech: show(f.partOfSpeech),
    usageNote: show(f.usageNote),
    examples: f.examples
      .map((e) => [show(e.ja), e.reading ? `(${show(e.reading)})` : "", e.vi ? `— ${show(e.vi)}` : ""].filter(Boolean).join(" "))
      .join("\n"),
    confusables: f.confusables.map((c) => `${show(c.term)}: ${show(c.note)}`).join("\n"),
  };
}

function extractJson(text: string): string | null {
  const stripped = text.replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  return start === -1 || end <= start ? null : stripped.slice(start, end + 1);
}

const MAX_ISSUES = 5;

function formatIssues(issues: { path: PropertyKey[]; message: string }[], data: unknown): string {
  const words = (data as { words?: unknown })?.words;
  const lines = issues.slice(0, MAX_ISSUES).map((issue) => {
    const [root, index] = issue.path;
    if (root === "words" && typeof index === "number") {
      const term = Array.isArray(words) ? (words[index] as { term?: unknown })?.term : undefined;
      return `Từ thứ ${index + 1}${typeof term === "string" ? ` (${term})` : ""}: ${issue.message}`;
    }
    return issue.message;
  });
  const more = issues.length > MAX_ISSUES ? `\n… và ${issues.length - MAX_ISSUES} lỗi khác.` : "";
  return `Kết quả không đúng định dạng, chưa lưu gì:\n${lines.join("\n")}${more}`;
}
