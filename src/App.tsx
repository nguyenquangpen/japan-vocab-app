import { useEffect, useState } from "react";
import { openAppDb } from "./db/tauriDb";
import AddWordsTab from "./tabs/AddWordsTab";
import LibraryTab from "./tabs/LibraryTab";
import ReviewTab from "./tabs/ReviewTab";
import SettingsTab from "./tabs/SettingsTab";
import "./App.css";

const TABS = [
  { id: "review", label: "Ôn tập", Component: ReviewTab },
  { id: "add", label: "Thêm từ", Component: AddWordsTab },
  { id: "library", label: "Kho từ", Component: LibraryTab },
  { id: "settings", label: "Cài đặt", Component: SettingsTab },
] as const;

type TabId = (typeof TABS)[number]["id"];

type DbStatus = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

export default function App() {
  const [tab, setTab] = useState<TabId>("review");
  const [dbStatus, setDbStatus] = useState<DbStatus>({ kind: "loading" });

  useEffect(() => {
    openAppDb()
      .then((db) => db.select("SELECT key FROM settings LIMIT 1"))
      .then(() => setDbStatus({ kind: "ready" }))
      .catch((error: unknown) => setDbStatus({ kind: "error", message: String(error) }));
  }, []);

  const Current = TABS.find((t) => t.id === tab)!.Component;

  return (
    <div className="app">
      <nav className="tabs">
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
        {dbStatus.kind === "ready" && <Current />}
      </main>
    </div>
  );
}
