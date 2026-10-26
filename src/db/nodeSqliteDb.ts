// Adapter cho test (chạy trong Node). Không import file này từ code giao diện.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Db } from "./db";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../src-tauri/migrations");

/** DB SQLite trong bộ nhớ, đã chạy toàn bộ migration theo thứ tự tên file. */
export function createTestDb(): Db {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  return {
    async execute(sql, params = []) {
      const result = database.prepare(sql).run(...(params as SQLInputValue[]));
      return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
    async select<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
  };
}
