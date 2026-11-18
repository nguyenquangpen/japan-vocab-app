// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/nodeSqliteDb";
import { loadHubConfig, saveHubConfig } from "../hub/config";
import { enqueueEvent } from "../hub/events";
import { createFakeHub } from "../hub/fakeHub.test-helpers";
import { createHubSender } from "../hub/sender";
import HubSettings from "./HubSettings";

afterEach(cleanup);

const KEY = `pph_${"Qw34".repeat(8)}`;

describe("HubSettings", () => {
  it("lưu cấu hình; key không hiện lại, chỉ hiện dạng che", async () => {
    const db = createTestDb();
    const { container } = render(<HubSettings db={db} />);
    const keyInput = (await screen.findByLabelText(/API key/)) as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    expect(screen.getByText("Chưa có key")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Gửi tiến độ học sang Hub/ }));
    fireEvent.change(keyInput, { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình Hub" }));
    await screen.findByText("Đã lưu cấu hình Hub.");

    expect(await loadHubConfig(db)).toEqual({ enabled: true, url: "http://127.0.0.1:4317", apiKey: KEY });
    expect(screen.getByText("Đã lưu key (pph_••••)")).toBeTruthy();
    expect(keyInput.value).toBe("");
    expect(container.textContent).not.toContain(KEY);
    expect(keyInput.getAttribute("value") ?? "").not.toContain(KEY);
  });

  it("báo lỗi khi URL không phải 127.0.0.1", async () => {
    const db = createTestDb();
    render(<HubSettings db={db} />);
    fireEvent.change(await screen.findByLabelText("Địa chỉ Hub"), { target: { value: "http://localhost:4317" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình Hub" }));
    await screen.findByText(/phải có dạng http:\/\/127\.0\.0\.1/);
  });

  it("hiện trạng thái, cảnh báo key và thử lại sự kiện lỗi", async () => {
    const db = createTestDb();
    await saveHubConfig(db, { enabled: true, url: "http://127.0.0.1:4317", apiKey: KEY });
    const hub = createFakeHub(KEY);
    hub.respond = () => ({ kind: "response", status: 401, body: "" });
    const sender = createHubSender({ db, post: hub.post });
    await enqueueEvent(db, { type: "lesson.completed", subject: { type: "lesson", external_id: "a" }, data: { title: "t" }, occurredAt: new Date() });
    await sender.kick();

    render(<HubSettings db={db} sender={sender} />);
    await screen.findByText("Cần cấu hình lại API key của Hub");
    expect(screen.getByText("Đang chờ gửi: 1 sự kiện")).toBeTruthy();

    // Một sự kiện failed → có nút thử lại.
    await db.execute("UPDATE hub_outbox SET status = 'failed', last_error = 'HTTP 400 VALIDATION: x'");
    cleanup();
    hub.respond = undefined;
    const sender2 = createHubSender({ db, post: hub.post });
    render(<HubSettings db={db} sender={sender2} />);
    fireEvent.click(await screen.findByRole("button", { name: "Thử lại sự kiện lỗi" }));
    await screen.findByText("Gửi lỗi: 0 sự kiện");
    expect(screen.getByText("Đang chờ gửi: 0 sự kiện")).toBeTruthy();
    expect(screen.queryByText(/chưa có$/)).toBeNull();
  });
});
