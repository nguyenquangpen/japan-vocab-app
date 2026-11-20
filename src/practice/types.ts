// Kiểu dữ liệu dùng chung cho tab Luyện tập. Luyện tập không đổi lịch ôn FSRS, không ghi review_logs.

/** Câu điền từ: câu tiếng Nhật bị khoét đúng chỗ của từ (đáp án có thể là dạng đã chia, vd. 食べた). */
export interface ClozeItem {
  kind: "cloze";
  /** id trong bảng practice_items; 0 nếu dựng tạm từ câu ví dụ có sẵn. */
  id: number;
  wordId: number;
  before: string;
  answer: string;
  after: string;
  /** Nghĩa tiếng Việt của cả câu. */
  vi: string | null;
  /** Đáp án nhiễu (có thể rỗng: giao diện tự bù bằng từ khác trong phạm vi). */
  distractors: string[];
  /** Cách đọc hiragana (câu ChatGPT tạo mới có; câu cũ / câu ví dụ thì không). */
  readings?: ClozeReadings | null;
}

export interface ClozeReadings {
  before: string;
  answer: string;
  after: string;
  /** Cùng thứ tự với distractors; null nếu thiếu. */
  distractors: (string | null)[];
}

/** Câu xếp mảnh: `pieces` theo đúng thứ tự; giao diện xáo trộn rồi để người học xếp lại. */
export interface OrderItem {
  kind: "order";
  id: number;
  wordId: number;
  pieces: string[];
  /** Cách đọc kana của từng mảnh (cùng độ dài với `pieces`); null với câu tạo trước khi có trường này. */
  readings: string[] | null;
  vi: string | null;
}

export type PracticeItem = ClozeItem | OrderItem;
