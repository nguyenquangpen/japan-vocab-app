import { useEffect, useState } from "react";
import type { Db } from "./db/db";
import { openAppDb } from "./db/tauriDb";
import AddWordsTab from "./tabs/AddWordsTab";
import LibraryTab from "./tabs/LibraryTab";
import ReviewTab from "./tabs/ReviewTab";
import SettingsTab from "./tabs/SettingsTab";
import "./App.css";
import "./theme.css";

const TABS = [
  { id: "review", label: "Ôn tập" },
  { id: "add", label: "Thêm từ" },
  { id: "library", label: "Kho từ" },
  { id: "settings", label: "Cài đặt" },
] as const;

type TabId = (typeof TABS)[number]["id"];

type DbStatus = { kind: "loading" } | { kind: "ready"; db: Db } | { kind: "error"; message: string };

export default function App() {
  const [tab, setTab] = useState<TabId>("review");
  const [dbStatus, setDbStatus] = useState<DbStatus>({ kind: "loading" });
  const [openWordId, setOpenWordId] = useState<number | null>(null);

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
            {tab === "review" && <ReviewTab db={dbStatus.db} />}
            {tab === "add" && <AddWordsTab db={dbStatus.db} onOpenWord={openWord} />}
            {tab === "library" && (
              <LibraryTab db={dbStatus.db} selectedId={openWordId} onSelect={setOpenWordId} />
            )}
            {tab === "settings" && <SettingsTab db={dbStatus.db} />}
          </div>
        )}
      </main>
    </div>
  );
}
