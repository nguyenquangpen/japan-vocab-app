import { describe, expect, it } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { DEFAULT_SETTINGS, loadSettings } from "./settings";

describe("loadSettings", () => {
  it("đọc giá trị mặc định từ migration", async () => {
    expect(await loadSettings(createTestDb())).toEqual(DEFAULT_SETTINGS);
  });

  it("giá trị hỏng thì dùng mặc định", async () => {
    const db = createTestDb();
    await db.execute("UPDATE settings SET value = ? WHERE key = ?", ["abc", "new_per_day"]);
    await db.execute("UPDATE settings SET value = ? WHERE key = ?", ["N3", "level"]);
    await db.execute("DELETE FROM settings WHERE key = ?", ["grade_buttons"]);
    expect(await loadSettings(db)).toEqual({ ...DEFAULT_SETTINGS, level: "N3" });
  });
});
