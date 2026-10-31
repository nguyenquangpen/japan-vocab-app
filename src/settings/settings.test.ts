import { describe, expect, it } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";

describe("saveSettings", () => {
  it("lưu rồi đọc lại được, kể cả khi key đã bị xóa", async () => {
    const db = createTestDb();
    await db.execute("DELETE FROM settings WHERE key = ?", ["grade_buttons"]);
    const next = { level: "N3", newPerDay: 0, sessionSize: 50, gradeButtons: 4 as const };
    expect(await saveSettings(db, next)).toEqual({ ok: true });
    expect(await loadSettings(db)).toEqual(next);
  });

  it("từ chối giá trị không hợp lệ và không ghi gì", async () => {
    const db = createTestDb();
    const bad = [
      { ...DEFAULT_SETTINGS, level: "N6" },
      { ...DEFAULT_SETTINGS, newPerDay: -1 },
      { ...DEFAULT_SETTINGS, newPerDay: 1.5 },
      { ...DEFAULT_SETTINGS, sessionSize: 4 },
      { ...DEFAULT_SETTINGS, sessionSize: 51 },
      { ...DEFAULT_SETTINGS, gradeButtons: 3 as unknown as 2 },
    ];
    for (const settings of bad) expect(await saveSettings(db, settings)).toMatchObject({ ok: false });
    expect(await loadSettings(db)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("loadSettings", () => {
  it("đọc giá trị mặc định từ migration", async () => {
    expect(await loadSettings(createTestDb())).toEqual(DEFAULT_SETTINGS);
  });

  it("giá trị hỏng thì dùng mặc định", async () => {
    const db = createTestDb();
    await db.execute("UPDATE settings SET value = ? WHERE key = ?", ["abc", "new_per_day"]);
    await db.execute("UPDATE settings SET value = ? WHERE key = ?", ["N3", "level"]);
    await db.execute("DELETE FROM settings WHERE key = ?", ["grade_buttons"]);
    await db.execute("INSERT INTO settings (key, value) VALUES (?, ?)", ["session_size", "999"]);
    expect(await loadSettings(db)).toEqual({ ...DEFAULT_SETTINGS, level: "N3" });
  });
});
