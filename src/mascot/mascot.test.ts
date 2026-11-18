import { describe, expect, it } from "vitest";
import { MASCOTS, getMascot, isMascotId, pickMascotMessage } from "./mascot";

describe("isMascotId", () => {
  it("chỉ nhận id có trong danh sách", () => {
    for (const m of MASCOTS) expect(isMascotId(m.id)).toBe(true);
    expect(isMascotId("dragon")).toBe(false);
    expect(isMascotId("")).toBe(false);
    expect(isMascotId(undefined)).toBe(false);
  });

  it("id không trùng nhau và getMascot trả đúng linh vật", () => {
    expect(new Set(MASCOTS.map((m) => m.id)).size).toBe(MASCOTS.length);
    expect(getMascot("fox").emoji).toBe("🦊");
  });
});

describe("pickMascotMessage", () => {
  it("nhớ hết là hoàn hảo", () => {
    const msg = pickMascotMessage(10, 10, () => 0);
    expect(msg).toMatchObject({ perfect: true, title: "Hoàn hảo!" });
  });

  it("lượt rỗng hoặc sót thẻ thì không hoàn hảo", () => {
    expect(pickMascotMessage(0, 0).perfect).toBe(false);
    expect(pickMascotMessage(9, 10).perfect).toBe(false);
  });

  it("chọn nhóm lời nhắn theo tỉ lệ nhớ", () => {
    const perfectTitles = new Set<string>();
    const goodTitles = new Set<string>();
    const lowTitles = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const rng = () => i / 10;
      perfectTitles.add(pickMascotMessage(5, 5, rng).title);
      goodTitles.add(pickMascotMessage(7, 10, rng).title);
      lowTitles.add(pickMascotMessage(6, 10, rng).title);
    }
    // Có nhiều lời nhắn khác nhau và các nhóm không lẫn vào nhau.
    expect(perfectTitles.size).toBeGreaterThan(1);
    expect(goodTitles.size).toBeGreaterThan(1);
    expect(lowTitles.size).toBeGreaterThan(1);
    for (const t of goodTitles) expect(perfectTitles.has(t) || lowTitles.has(t)).toBe(false);
    for (const t of lowTitles) expect(perfectTitles.has(t)).toBe(false);
  });

  it("rng trả giá trị biên vẫn ra lời nhắn hợp lệ", () => {
    expect(pickMascotMessage(1, 2, () => 0.9999).text).not.toBe("");
    expect(pickMascotMessage(1, 2, () => 1).text).not.toBe("");
  });
});
