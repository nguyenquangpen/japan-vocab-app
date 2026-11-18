import { useEffect, useMemo, useState } from "react";
import type { Db } from "./db/db";
import { openAppDb } from "./db/tauriDb";
import { createHubSender, type HubSender } from "./hub/sender";
import { tauriHubPost } from "./hub/tauriPost";
import AddWordsTab from "./tabs/AddWordsTab";
import LibraryTab from "./tabs/LibraryTab";
import { loadCloze, loadOrder } from "./practice/generated";
import PracticeTab, { type GeneratedSource } from "./tabs/PracticeTab";
import ReviewTab from "./tabs/ReviewTab";
import SettingsTab from "./tabs/SettingsTab";
import StatsTab from "./tabs/StatsTab";
import "./App.css";
import "./theme.css";

const TABS = [
  { id: "review", label: "Ôn tập" },
  { id: "add", label: "Thêm từ" },
  { id: "library", label: "Kho từ" },
  { id: "practice", label: "Luyện tập" },
  { id: "stats", label: "Thống kê" },
  { id: "settings", label: "Cài đặt" },
] as const;

// Câu luyện tập do ChatGPT tạo (bảng practice_items). Hằng cấp module để tham chiếu ổn định.
const GENERATED: GeneratedSource = { loadCloze, loadOrder };

type TabId = (typeof TABS)[number]["id"];

type DbStatus = { kind: "loading" } | { kind: "ready"; db: Db } | { kind: "error"; message: string };

export default function App() {
  const [tab, setTab] = useState<TabId>("review");
  const [dbStatus, setDbStatus] = useState<DbStatus>({ kind: "loading" });
  const [openWordId, setOpenWordId] = useState<number | null>(null);
  // Bộ gửi sự kiện sang Personal Productivity Hub (chạy nền, chỉ gửi khi đã bật + có API key).
  // Tạo đối tượng không có tác dụng phụ; start/stop nằm trong effect (start lặp lại được).
  const db = dbStatus.kind === "ready" ? dbStatus.db : null;
  const hub = useMemo<HubSender | null>(() => (db ? createHubSender({ db, post: tauriHubPost }) : null), [db]);

  useEffect(() => {
    if (!hub) return;
    hub.start();
    return () => hub.stop();
  }, [hub]);

  useEffect(() => {
    openAppDb()
      .then(async (db) => {
        await db.select("SELECT key FROM settings LIMIT 1");
        setDbStatus({ kind: "ready", db });
      })
      .catch((error: unknown) => setDbStatus({ kind: "error", message: String(error) }));
  }, []);

  function openWord(wordId: number) {
    setOpenWordId(wordId);
    setTab("library");
  }

  return (
    <div className="app">
      <nav className="tabs">
        <span className="brand">
          <span className="brand-mark jp">語</span>
          Japan Vocab
        </span>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={t.id === tab ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="content">
        {dbStatus.kind === "loading" && <p className="muted">Đang mở dữ liệu…</p>}
        {dbStatus.kind === "error" && (
          <p className="error">Không mở được dữ liệu: {dbStatus.message}</p>
        )}
        {dbStatus.kind === "ready" && (
          <div key={tab} className="tab-page">
            {tab === "review" && <ReviewTab db={dbStatus.db} hub={hub} />}
            {tab === "add" && <AddWordsTab db={dbStatus.db} onOpenWord={openWord} />}
            {tab === "library" && (
              <LibraryTab db={dbStatus.db} selectedId={openWordId} onSelect={setOpenWordId} />
            )}
            {tab === "practice" && <PracticeTab db={dbStatus.db} generated={GENERATED} hub={hub} />}
            {tab === "stats" && <StatsTab db={dbStatus.db} />}
            {tab === "settings" && <SettingsTab db={dbStatus.db} hub={hub} />}
          </div>
        )}
      </main>
    </div>
  );
}
