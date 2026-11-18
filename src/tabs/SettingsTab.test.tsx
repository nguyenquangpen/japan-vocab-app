// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { loadSettings } from "../settings/settings";
import SettingsTab from "./SettingsTab";

afterEach(cleanup);

describe("SettingsTab", () => {
  it("chọn linh vật rồi bấm Lưu thì lưu vào settings", async () => {
    const db = createTestDb();
    render(<SettingsTab db={db} />);
    const frog = await screen.findByRole("radio", { name: "Ếch Kero" });
    expect((screen.getByRole("radio", { name: "Mèo Tama" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(frog);
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await screen.findByText(/Đã lưu/);
    expect((await loadSettings(db)).mascot).toBe("frog");
  });
});
