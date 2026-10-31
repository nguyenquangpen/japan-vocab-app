// Prompt giải thích các từ bấm Quên trong phiên (docs/design.md mục 5.3). Không dán kết quả lại vào app.

export interface Mistake {
  term: string;
  reading: string | null;
  meanings: string[];
}

export function buildMistakesPrompt(mistakes: Mistake[], level: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of mistakes) {
    const key = `${m.term}|${m.reading ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reading = m.reading && m.reading !== m.term ? ` (${m.reading})` : "";
    lines.push(`${lines.length + 1}. ${m.term}${reading} — nghĩa: ${m.meanings.join("; ")}`);
  }

  return `Bạn là giáo viên tiếng Nhật cho người Việt, trình độ học viên: ${level}.
Trong buổi ôn flashcard vừa rồi tôi quên các từ dưới đây. Với mỗi từ:
- Giải thích ngắn gọn nghĩa và cách đọc, kèm mẹo để nhớ (ví dụ phân tích chữ Hán).
- Nếu từ dễ nhầm với từ khác, chỉ ra và phân biệt.
- Cho 1 câu ví dụ ngắn, ngữ pháp không vượt quá trình độ ${level}.
Cuối cùng, nếu trong danh sách có những từ dễ nhầm với nhau, gom lại và phân biệt.
Trả lời bằng tiếng Việt, ngắn gọn.

Các từ tôi quên:
${lines.join("\n")}`;
}
