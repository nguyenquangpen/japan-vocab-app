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
