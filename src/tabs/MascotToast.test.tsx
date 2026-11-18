// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MascotToast, { MASCOT_TOAST_MS } from "./MascotToast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("MascotToast", () => {
  it("nhớ hết thì linh vật giơ bảng với lời khen", () => {
    render(<MascotToast mascot="shiba" remembered={8} total={8} onClose={() => {}} />);
    const status = screen.getByRole("status");
    expect(status.querySelector(".mascot-sign-board")?.textContent).toMatch(/!/);
    expect(status.querySelector(".mascot-bubble")).toBeNull();
    expect(screen.getByRole("img", { name: "Chó Shiba" }).textContent).toBe("🐶");
  });

  it("chưa nhớ hết thì hiện bong bóng động viên kèm điểm", () => {
    render(<MascotToast mascot="cat" remembered={3} total={8} onClose={() => {}} />);
    const status = screen.getByRole("status");
    expect(status.querySelector(".mascot-sign-board")).toBeNull();
    expect(status.querySelector(".mascot-bubble")).not.toBeNull();
    expect(screen.getByText("Nhớ 3/8 thẻ")).toBeTruthy();
  });

  it("bấm Đóng thì gọi onClose", () => {
    const onClose = vi.fn();
    render(<MascotToast mascot="fox" remembered={1} total={2} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("tự đóng sau một lúc, kể cả khi onClose đổi giữa chừng", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<MascotToast mascot="panda" remembered={2} total={2} onClose={first} />);
    act(() => vi.advanceTimersByTime(MASCOT_TOAST_MS - 100));
    rerender(<MascotToast mascot="panda" remembered={2} total={2} onClose={second} />);
    expect(first).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("gỡ trước khi hết giờ thì không gọi onClose", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { unmount } = render(<MascotToast mascot="frog" remembered={0} total={3} onClose={onClose} />);
    unmount();
    act(() => vi.advanceTimersByTime(MASCOT_TOAST_MS * 2));
    expect(onClose).not.toHaveBeenCalled();
  });
});
