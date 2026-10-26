import type { Db } from "../db/db";

export interface Settings {
  level: string;
  newPerDay: number;
  maxReviewsPerSession: number;
  gradeButtons: 2 | 4;
}

export const DEFAULT_SETTINGS: Settings = {
  level: "N5",
  newPerDay: 10,
  maxReviewsPerSession: 100,
  gradeButtons: 2,
};

export const LEVELS = ["N5", "N4", "N3", "N2", "N1"] as const;
export const NEW_PER_DAY_MAX = 100;
export const MAX_REVIEWS_MAX = 1000;

export type SaveResult = { ok: true } | { ok: false; message: string };

/** Kiểm tra rồi ghi toàn bộ settings bằng 1 câu lệnh. */
export async function saveSettings(db: Db, settings: Settings): Promise<SaveResult> {
  const { level, newPerDay, maxReviewsPerSession, gradeButtons } = settings;
  if (!(LEVELS as readonly string[]).includes(level)) return { ok: false, message: "Trình độ không hợp lệ." };
  if (!Number.isInteger(newPerDay) || newPerDay < 0 || newPerDay > NEW_PER_DAY_MAX) {
    return { ok: false, message: `Số từ mới mỗi ngày phải là số nguyên từ 0 đến ${NEW_PER_DAY_MAX}.` };
  }
  if (!Number.isInteger(maxReviewsPerSession) || maxReviewsPerSession < 1 || maxReviewsPerSession > MAX_REVIEWS_MAX) {
    return { ok: false, message: `Số thẻ tối đa mỗi phiên phải là số nguyên từ 1 đến ${MAX_REVIEWS_MAX}.` };
  }
  if (gradeButtons !== 2 && gradeButtons !== 4) return { ok: false, message: "Kiểu nút chấm phải là 2 hoặc 4." };

  await db.execute(
    `INSERT INTO settings (key, value) VALUES (?, ?), (?, ?), (?, ?), (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [
      "level", level,
      "new_per_day", String(newPerDay),
      "max_reviews_per_session", String(maxReviewsPerSession),
      "grade_buttons", String(gradeButtons),
    ],
  );
  return { ok: true };
}

/** Đọc settings, giá trị thiếu hoặc hỏng thì dùng mặc định. */
export async function loadSettings(db: Db): Promise<Settings> {
  const rows = await db.select<{ key: string; value: string }>("SELECT key, value FROM settings");
  const raw = new Map(rows.map((r) => [r.key, r.value]));
  const int = (key: string, fallback: number) => {
    const n = Number.parseInt(raw.get(key) ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    level: raw.get("level")?.trim() || DEFAULT_SETTINGS.level,
    newPerDay: int("new_per_day", DEFAULT_SETTINGS.newPerDay),
    maxReviewsPerSession: int("max_reviews_per_session", DEFAULT_SETTINGS.maxReviewsPerSession),
    gradeButtons: raw.get("grade_buttons") === "4" ? 4 : 2,
  };
}
