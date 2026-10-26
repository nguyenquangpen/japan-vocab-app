import type { Skill } from "./scheduler";

// Prompt giải thích lỗi sai cuối phiên (docs/design.md mục 5.3). Không dán kết quả lại vào app.

export interface Mistake {
  term: string;
  reading: string;
  meanings: string[];
  skill: Skill;
  /** Câu đã gõ (thẻ reading). null với thẻ meaning (tự chấm). */
  answer: string | null;
}

export function buildMistakesPrompt(mistakes: Mistake[], level: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of mistakes) {
    const key = `${m.term}|${m.skill}|${m.answer ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const skill =
      m.skill === "reading"
        ? `kỹ năng: cách đọc — tôi gõ: ${m.answer ?? "(trống)"}`
        : "kỹ năng: nghĩa — tôi tự chấm là quên";
    lines.push(`${lines.length + 1}. ${m.term} (${m.reading}) — nghĩa: ${m.meanings.join("; ")} — ${skill}`);
  }

  return `Bạn là giáo viên tiếng Nhật cho người Việt, trình độ học viên: ${level}.
Trong buổi ôn vừa rồi tôi trả lời sai các từ dưới đây. Với mỗi từ:
- Giải thích ngắn gọn nghĩa và cách đọc đúng, kèm mẹo để nhớ.
- Nếu câu tôi gõ là một từ có thật hoặc giống từ khác, chỉ ra tôi đang nhầm với từ nào và phân biệt hai từ.
- Cho 1 câu ví dụ ngắn, ngữ pháp không vượt quá trình độ ${level}.
Cuối cùng, nếu trong danh sách có những từ dễ nhầm với nhau, gom lại và phân biệt.
Trả lời bằng tiếng Việt, ngắn gọn.

Các từ trả lời sai:
${lines.join("\n")}`;
}
