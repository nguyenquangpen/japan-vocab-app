import Database from "@tauri-apps/plugin-sql";
import type { Db } from "./db";

// Phải khớp với tên DB khai báo migration trong src-tauri/src/lib.rs.
const DB_URL = "sqlite:vocab.db";

let opening: Promise<Db> | null = null;

/** Mở DB của app (migration chạy khi mở lần đầu). Gọi nhiều lần trả về cùng 1 kết nối. */
export function openAppDb(): Promise<Db> {
  opening ??= Database.load(DB_URL).then(
    (database): Db => ({
      execute: (sql, params = []) => database.execute(sql, params),
      select: (sql, params = []) => database.select(sql, params),
    }),
  );
  return opening;
}
