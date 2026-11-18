import { z } from "zod";
import type { Db } from "../db/db";
import { normalizeText } from "../vocab/text";
import type { ClozeItem, OrderItem } from "./types";

// Câu luyện tập do ChatGPT tạo qua copy–paste (docs/design.md mục 5). Không đụng cards/review_logs.

// Không để zod thử tăng tốc bằng `new Function` (CSP chặn và CLAUDE.md cấm).
z.config({ jitless: true });

export function buildPracticePrompt(
  words: { term: string; reading: string | null; meanings: string[] }[],
  level: string,
): string {
  const list = words
    .map((w) => {
      const reading = w.reading ? ` (${w.reading})` : "";
      const meanings = w.meanings.length > 0 ? `: ${w.meanings.join(", ")}` : "";
      return `${w.term}${reading}${meanings}`;
    })
    .join("\n");
  return `Bạn là giáo viên tiếng Nhật cho người Việt, trình độ học viên: ${level}.
Với mỗi từ dưới đây, tạo bài luyện tập theo đúng định dạng JSON ở cuối:
- cloze: 2 câu điền từ. before + answer + after ghép lại phải là một câu tiếng Nhật tự nhiên, đầy đủ.
  answer là chính từ đó đúng như trong câu (có thể đã chia, vd. 食べた).
  distractors: 3 từ sai nhưng hợp lý, cùng từ loại với answer.
- order: 1 câu xếp mảnh. pieces gồm 3–7 cụm (kiểu bunsetsu, trợ từ dính vào cụm trước), ghép theo thứ tự đúng phải ra nguyên câu.
  readings: cách đọc hiragana của từng mảnh, cùng số phần tử và cùng thứ tự với pieces.
- vi: bản dịch tiếng Việt của cả câu.
- Ngữ pháp và từ vựng trong câu không vượt quá trình độ ${level}.
- term giữ nguyên như trong danh sách (không kèm cách đọc, nghĩa).
Chỉ trả về JSON, không giải thích thêm, không dùng markdown.

Danh sách từ:
${list}

Định dạng:
{"items":[{"term":"","cloze":[{"before":"","answer":"","after":"","vi":"","distractors":["","",""]}],"order":[{"pieces":["",""],"readings":["",""],"vi":""}]}]}`;
}

const text = (max: number, label: string) =>
  z.string({ error: `${label} phải là chuỗi.` }).max(max, { error: `${label} dài quá ${max} ký tự.` });

const clozeSchema = z.object({
  before: text(200, "cloze.before"),
  answer: text(200, "cloze.answer").min(1, { error: "cloze.answer không được rỗng." }),
  after: text(200, "cloze.after"),
  vi: text(200, "cloze.vi").nullish(),
  distractors: z
    .array(text(30, "cloze.distractors"), { error: "cloze.distractors phải là mảng." })
    .max(3, { error: "cloze.distractors tối đa 3 từ." })
    .default([]),
});

const orderSchema = z.object({
  pieces: z
    .array(
      text(40, "order.pieces").min(1, { error: "order.pieces không được có mảnh rỗng." }),
      { error: "order.pieces phải là mảng." },
    )
    .min(2, { error: "order.pieces cần ít nhất 2 mảnh." })
    .max(8, { error: "order.pieces tối đa 8 mảnh." }),
  // Cách đọc từng mảnh: tùy chọn; sai số lượng thì bỏ qua (không báo lỗi).
  readings: z.array(text(60, "order.readings")).max(8, { error: "order.readings tối đa 8 mảnh." }).nullish(),
  vi: text(200, "order.vi").nullish(),
});

const responseSchema = z.object({
  items: z
    .array(
      z.object({
        term: text(30, "term").min(1, { error: "term không được rỗng." }),
        cloze: z.array(clozeSchema, { error: "cloze phải là mảng." }).max(3, { error: "cloze tối đa 3 câu." }).default([]),
        order: z.array(orderSchema, { error: "order phải là mảng." }).max(2, { error: "order tối đa 2 câu." }).default([]),
      }),
      { error: "Thiếu mảng items." },
    )
    .min(1, { error: "items không được rỗng." })
    .max(30, { error: "items tối đa 30 từ." }),
});

export type ClozeData = Omit<ClozeItem, "id" | "wordId" | "kind">;
export type OrderData = Omit<OrderItem, "id" | "wordId" | "kind">;

export interface ParsedPractice {
  wordId: number;
  cloze: ClozeData[];
  order: OrderData[];
}

export type PracticeParseResult =
  | { ok: true; items: ParsedPractice[]; unmatched: string[]; missing: string[] }
  | { ok: false; message: string };

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

export function parsePracticeResponse(text: string, batch: { id: number; term: string }[]): PracticeParseResult {
  const json = extractJson(text);
  if (json === null) return { ok: false, message: "Không tìm thấy JSON trong nội dung dán vào." };

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, message: "JSON bị lỗi cú pháp (có thể bị cắt mất hoặc thừa ký tự). Hãy copy lại toàn bộ kết quả." };
  }

  const parsed = responseSchema.safeParse(data);
  if (!parsed.success) return { ok: false, message: formatIssues(parsed.error.issues, data) };

  const matched = new Set<number>();
  const items: ParsedPractice[] = [];
  const unmatched: string[] = [];
  const empty: string[] = [];

  for (const item of parsed.data.items) {
    const term = normalizeText(item.term);
    const pick = batch.find((w) => !matched.has(w.id) && normalizeText(w.term) === term);
    if (!pick) {
      unmatched.push(item.term);
      continue;
    }
    matched.add(pick.id);
    const cloze = item.cloze
      .map((c) => ({
        before: c.before.trim(),
        answer: c.answer.trim(),
        after: c.after.trim(),
        vi: clean(c.vi),
        distractors: c.distractors.map((d) => d.trim()).filter((d) => d !== ""),
      }))
      // Bỏ câu rỗng đáp án hoặc câu mà phần còn lại vẫn chứa đáp án (lộ đáp án).
      .filter((c) => c.answer !== "" && !`${c.before}${c.after}`.includes(c.answer));
    const order = item.order
      .map((o) => {
        // Giữ cách đọc chỉ khi khớp từng mảnh (cùng số lượng, không mảnh rỗng).
        const pairs = o.pieces.map((p, i) => ({ piece: p.trim(), reading: (o.readings?.[i] ?? "").trim() }));
        const kept = pairs.filter((x) => x.piece !== "");
        const readingsOk =
          o.readings?.length === o.pieces.length && kept.every((x) => x.reading !== "") && kept.length === pairs.length;
        return { pieces: kept.map((x) => x.piece), readings: readingsOk ? kept.map((x) => x.reading) : null, vi: clean(o.vi) };
      })
      .filter((o) => o.pieces.length >= 2);
    // Không còn câu dùng được: không đưa vào (để lưu không xóa mất câu cũ của từ này).
    if (cloze.length === 0 && order.length === 0) {
      empty.push(pick.term);
      continue;
    }
    items.push({ wordId: pick.id, cloze, order });
  }

  const missing = [...batch.filter((w) => !matched.has(w.id)).map((w) => w.term), ...empty];
  return { ok: true, items, unmatched, missing };
}

function extractJson(text: string): string | null {
  const stripped = text.replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  return start === -1 || end <= start ? null : stripped.slice(start, end + 1);
}

const MAX_ISSUES = 5;

function formatIssues(issues: { path: PropertyKey[]; message: string }[], data: unknown): string {
  const items = (data as { items?: unknown })?.items;
  const lines = issues.slice(0, MAX_ISSUES).map((issue) => {
    const [root, index] = issue.path;
    if (root === "items" && typeof index === "number") {
      const term = Array.isArray(items) ? (items[index] as { term?: unknown })?.term : undefined;
      return `Từ thứ ${index + 1}${typeof term === "string" ? ` (${term})` : ""}: ${issue.message}`;
    }
    return issue.message;
  });
  const more = issues.length > MAX_ISSUES ? `\n… và ${issues.length - MAX_ISSUES} lỗi khác.` : "";
  return `Kết quả không đúng định dạng, chưa lưu gì:\n${lines.join("\n")}${more}`;
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** Thay toàn bộ câu luyện tập cũ của các từ này bằng câu mới. Trả về số dòng đã thêm. */
export async function savePracticeItems(db: Db, items: ParsedPractice[], now = new Date()): Promise<number> {
  if (items.length === 0) return 0;
  const createdAt = now.toISOString();
  const wordIds = [...new Set(items.map((i) => i.wordId))];
  const rows: unknown[][] = [];
  for (const item of items) {
    for (const c of item.cloze) {
      const data = { before: c.before, answer: c.answer, after: c.after, distractors: c.distractors };
      rows.push([item.wordId, "cloze", JSON.stringify(data), c.vi, createdAt]);
    }
    for (const o of item.order) rows.push([item.wordId, "order", JSON.stringify({ pieces: o.pieces, readings: o.readings }), o.vi, createdAt]);
  }
  await db.execute(`DELETE FROM practice_items WHERE word_id IN (${placeholders(wordIds.length)})`, wordIds);
  if (rows.length === 0) return 0;
  await db.execute(
    `INSERT INTO practice_items (word_id, kind, data, vi, created_at) VALUES ${rows.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
    rows.flat(),
  );
  return rows.length;
}

interface Row {
  id: number;
  word_id: number;
  data: string;
  vi: string | null;
}

async function loadRows(db: Db, wordIds: number[], kind: "cloze" | "order"): Promise<Row[]> {
  if (wordIds.length === 0) return [];
  return db.select<Row>(
    `SELECT id, word_id, data, vi FROM practice_items
     WHERE kind = ? AND word_id IN (${placeholders(wordIds.length)}) ORDER BY id`,
    [kind, ...wordIds],
  );
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(value);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export async function loadCloze(db: Db, wordIds: number[]): Promise<ClozeItem[]> {
  const out: ClozeItem[] = [];
  for (const row of await loadRows(db, wordIds, "cloze")) {
    const d = parseJson(row.data);
    if (!d || typeof d.before !== "string" || typeof d.answer !== "string" || typeof d.after !== "string") continue;
    if (d.answer.trim() === "") continue;
    out.push({
      kind: "cloze",
      id: row.id,
      wordId: row.word_id,
      before: d.before,
      answer: d.answer,
      after: d.after,
      vi: row.vi,
      distractors: isStringArray(d.distractors) ? d.distractors : [],
    });
  }
  return out;
}

export async function loadOrder(db: Db, wordIds: number[]): Promise<OrderItem[]> {
  const out: OrderItem[] = [];
  for (const row of await loadRows(db, wordIds, "order")) {
    const d = parseJson(row.data);
    if (!d || !isStringArray(d.pieces) || d.pieces.length < 2) continue;
    const readings = isStringArray(d.readings) && d.readings.length === d.pieces.length ? d.readings : null;
    out.push({ kind: "order", id: row.id, wordId: row.word_id, pieces: d.pieces, readings, vi: row.vi });
  }
  return out;
}

export interface PromptWord {
  id: number;
  term: string;
  reading: string | null;
  meanings: string[];
}

/** Lấy term/reading/nghĩa của các từ để dựng prompt, giữ thứ tự id đầu vào. */
export async function listWordsForPrompt(db: Db, wordIds: number[]): Promise<PromptWord[]> {
  if (wordIds.length === 0) return [];
  const rows = await db.select<{ id: number; term: string; reading: string | null; meanings_vi: string | null }>(
    `SELECT id, term, reading, meanings_vi FROM words WHERE id IN (${placeholders(wordIds.length)})`,
    wordIds,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return wordIds.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    let meanings: string[] = [];
    try {
      const v: unknown = JSON.parse(r.meanings_vi ?? "[]");
      if (isStringArray(v)) meanings = v;
    } catch {
      // nghĩa hỏng thì bỏ qua
    }
    return [{ id: r.id, term: r.term, reading: r.reading, meanings }];
  });
}

export async function practiceItemCounts(db: Db, wordIds: number[]): Promise<{ cloze: number; order: number }> {
  if (wordIds.length === 0) return { cloze: 0, order: 0 };
  const rows = await db.select<{ kind: string; n: number }>(
    `SELECT kind, COUNT(*) AS n FROM practice_items WHERE word_id IN (${placeholders(wordIds.length)}) GROUP BY kind`,
    wordIds,
  );
  const get = (k: string) => Number(rows.find((r) => r.kind === k)?.n ?? 0);
  return { cloze: get("cloze"), order: get("order") };
}
