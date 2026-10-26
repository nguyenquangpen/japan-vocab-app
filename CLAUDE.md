# CLAUDE.md

## Dự án là gì

App desktop cá nhân giúp tôi (một người dùng duy nhất) tự xây kho từ vựng tiếng Nhật, ôn tập theo lịch lặp lại ngắt quãng (FSRS) và hiểu cách dùng từ.

- Mô tả sản phẩm: `docs/spec.md`
- Thiết kế kỹ thuật và các quyết định đã chốt: `docs/design.md`. **Đọc file này trước khi làm bất kỳ phần nào.**

Khi spec và design mâu thuẫn, **design.md thắng** (design là bản đã cắt gọn cho phiên bản đầu).

## Tiêu chí ưu tiên

1. Đơn giản, chạy được trước, tối ưu sau.
2. Dễ dùng: nhập từ nhanh, màn ôn ít thao tác.
3. Không tốn chi phí: không gọi API AI, AI làm qua copy–paste (xem design.md).

Không thêm tính năng ngoài design.md nếu tôi chưa đồng ý. Nếu thấy cần, đề xuất trước.

## Stack

- Tauri v2 + React + TypeScript + Vite
- SQLite qua `@tauri-apps/plugin-sql`
- `ts-fsrs` cho lịch ôn, `wanakana` cho romaji → kana, `zod` để kiểm tra JSON dán vào

## Quy tắc an toàn (bắt buộc)

- Không mở cổng mạng, không chạy server local, không gọi mạng ra ngoài.
- Chỉ bật đúng các Tauri plugin/permission cần thiết (sql, clipboard). Không bật shell, http, fs rộng.
- Đặt CSP chặt trong `tauri.conf.json`.
- Mọi nội dung dán vào (từ ChatGPT) là dữ liệu không tin cậy: parse qua schema `zod`, hiển thị dạng text thuần. Cấm `innerHTML`, `dangerouslySetInnerHTML`, `eval`, `new Function`.
- SQL luôn dùng tham số (`$1`, `?`), không nối chuỗi.

## Cách làm việc

- Làm theo các giai đoạn trong mục "Lộ trình" của design.md, xong giai đoạn nào chạy được giai đoạn đó rồi mới sang tiếp.
- Với việc lớn, đưa kế hoạch ngắn trước khi sửa code.
- Khi chốt quyết định mới trong lúc làm, cập nhật vào `docs/design.md`.
- Sau khi dựng khung dự án, cập nhật mục "Lệnh" bên dưới.

## Quy ước

- Trả lời tôi bằng tiếng Việt.
- Tên biến, hàm, bảng, cột bằng tiếng Anh. Chữ hiển thị trên giao diện bằng tiếng Việt.
- Thời gian lưu dạng ISO 8601 UTC.

## Lệnh

- Chạy app khi phát triển: `npm run tauri dev`
- Build bản cài: `npm run tauri build` (chỉ build exe, không đóng gói: `npx tauri build --no-bundle`)
- Test: `npm test` (Vitest, DB thật trong bộ nhớ qua `node:sqlite`)
- Kiểm tra kiểu: `npm run typecheck`
- Lint: `npm run lint`

Rust nằm ở `%USERPROFILE%\.cargo\bin`. Nếu terminal báo không có `cargo`, mở lại terminal/VS Code để nhận PATH mới.
