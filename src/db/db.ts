/**
 * Seam duy nhất giữa logic của app và SQLite.
 *
 * - SQL luôn dùng tham số `?` (không dùng `$1`: adapter node:sqlite cho test không bind được).
 * - Mỗi lời gọi là 1 câu lệnh. Không giả định 2 lời gọi liên tiếp chạy trên cùng 1 kết nối.
 * - Khóa ngoại (ON DELETE CASCADE) luôn bật ở cả 2 adapter.
 */
export interface Db {
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface ExecuteResult {
  rowsAffected: number;
  lastInsertId?: number;
}
