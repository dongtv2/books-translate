# Bảo mật & hiệu năng — sau đợt rà soát 2026-10-11

Rà soát toàn bộ webapp ngày 11/10/2026: tìm được 12 vấn đề bảo mật (2 mức trung bình, còn lại mức thấp).
Bảng dưới liệt kê cách xử lý từng vấn đề. Mỗi bản vá có test dựng lại đúng kiểu tấn công ban đầu (`npm run test:security`).

## Bảo mật

| # | Vấn đề | Đã sửa | Ở đâu |
|---|---|---|---|
| 1 | Lộ API key: nút "Kiểm tra kết nối" hoặc lưu cài đặt với `baseUrl` mới vẫn gửi khoá đã lưu tới địa chỉ mới | Khoá đã lưu chỉ được gửi tới **đúng địa chỉ đã lưu**. Đổi địa chỉ thì phải nhập lại khoá; nếu không nhập, khoá bị xoá. Cách làm tương tự cho client secret của SSO khi đổi issuer | `routes/settings.js`, `auth/oidc.js` |
| 2 | TTS: không giới hạn độ dài, bộ đệm phình mãi, lỗi 500 khi dữ liệu sai kiểu | Kiểm tra kiểu dữ liệu; tối đa 4000 ký tự (`TTS_MAX_CHARS`); bộ đệm tối đa 300 MB (`TTS_CACHE_MB`), xoá file ít dùng nhất trước; 60 lượt/phút | `routes/tts.js` |
| 3 | Thiếu header bảo mật | CSP chặt (script chỉ từ chính site, script nội tuyến cho phép qua hash, cấm nhúng trang vào iframe, cấm `object`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `COOP/CORP`, HSTS khi chạy https; tắt `X-Powered-By` | `security.js` |
| 4 | Gọi AI không giới hạn | Giới hạn theo người dùng mỗi phút: trợ lý 30, dịch 60, các tiện ích AI khác 30, TTS 60, upload 20 (`RATE_*`, đặt 0 để tắt); vượt giới hạn trả 429 kèm `Retry-After` | `security.js` |
| 5 | Open redirect sau SSO (`/\evil.com`) | `safeReturnTo` chặn `//`, `\`, scheme lạ, ký tự điều khiển, và kiểm tra lại bằng URL parser | `security.js`, `auth/oidc.js` |
| 6 | Mật khẩu tạm chỉ bị ép đổi ở giao diện | Server trả 403 `must_change_password` cho mọi API cho tới khi người dùng đổi mật khẩu | `auth/middleware.js` |
| 7 | Lỗi trả trang HTML có thể kèm stack trace | Trình xử lý lỗi cuối luôn trả JSON, không kèm chi tiết bên trong; đường dẫn `/api` không tồn tại cũng trả JSON 404 | `security.js`, `index.js` |
| 8 | Khoá API lưu dạng chữ rõ (cả trong bản sao lưu) | **AES-256-GCM**. Khoá giải mã lấy từ `SETTINGS_SECRET` hoặc file `server/data/secret.key` (quyền 600), không nằm trong database. Khoá cũ được tự mã hoá lại khi server khởi động | `secrets.js`, `settingsStore.js`, `auth/oidc.js` |
| 9 | `.gitignore` thiếu | Thêm `backups/`, `covers/`, `*.bak-*`, `secret.key`, `setup-token.txt` | `.gitignore` |
| 10 | Dữ liệu tích tụ không dọn | Phiên hết hạn bị xoá lúc khởi động và mỗi 6 giờ; bộ đếm đăng nhập sai tự dọn | `auth/store.js`, `routes/auth.js` |
| 11 | `mammoth` (đọc docx) kéo theo 3 lỗ hổng mức "moderate" | **Chưa sửa**: bản vá đòi đổi sang phiên bản không tương thích; chỉ gây treo và chỉ Biên tập viên dùng được | — |
| 12 | Khoá Riva truyền qua tham số dòng lệnh (đọc được bằng `ps`) | Truyền qua biến môi trường `RIVA_API_KEY` | `riva/rivaProcess.js`, `riva_nmt_server.py` |

**Lưu ý vận hành:**
- **Sao lưu `server/data/secret.key`** (hoặc đặt `SETTINGS_SECRET`) ở nơi an toàn, tách khỏi bản sao lưu database. Mất file này chỉ có nghĩa là phải nhập lại các API key; dữ liệu khác không ảnh hưởng.
- Các bản sao lưu tạo **trước** ngày 11/10 vẫn chứa khoá dạng chữ rõ. Nên xoá chúng, hoặc đổi API key ở phía nhà cung cấp.
- CSP tính hash của script nội tuyến trong `dist/index.html` lúc server khởi động. **Build xong (`npm run build`) phải khởi động lại server.** Nếu không, giao diện sáng/tối có thể nhấp nháy một khung hình khi mở trang.
- Khi chạy `npm run dev` (Vite, cổng 5173), trang do Vite phục vụ nên không có CSP; CSP chỉ áp dụng khi Express phục vụ bản build (`npm start`).

## Hiệu năng

Đo trên bản sao database thật:

| | Trước | Sau |
|---|---|---|
| JS tải lần đầu | 640 KB (1 file) | **81 KB** đã nén (bundle chính 259 KB; các trang tách riêng, tải ngầm khi trình duyệt rảnh) |
| Chương dài nhất qua mạng | 335 KB | **61 KB** (nén brotli) |
| 50 từ vựng qua mạng | 53 KB | **5 KB** |
| JS/CSS từ lần mở thứ hai | tải lại | cache 1 năm (tên file đổi theo nội dung khi build) |
| Font | `@import` trong CSS (tải lần lượt) | `<link>` trong `<head>`, tải song song |
| SQLite | mặc định | `synchronous=NORMAL` (an toàn với WAL), `busy_timeout` 5 s, cache 16 MB |

Phía server vốn đã nhanh: các API thường dưới 3 ms, chương lớn nhất khoảng 25 ms.

## Kiểm thử

`npm test` chạy 9 bộ kiểm thử, trong đó bộ engine giờ cũng chạy trên bản sao DB qua `server/test/withDbCopy.mjs`.

## Sổ tay sự cố

| Triệu chứng | Nguyên nhân thường gặp | Khắc phục |
|---|---|---|
| "Đã đổi địa chỉ máy chủ: hãy nhập lại API key" | Đã đổi `baseUrl` của nhà cung cấp AI | Nhập lại API key cho địa chỉ mới (đúng thiết kế) |
| Sau khi chuyển máy hoặc khôi phục, các API key trống | `secret.key` khác với máy cũ | Chép `secret.key` cũ vào `server/data/` (hoặc đặt `SETTINGS_SECRET` giống máy cũ), hoặc nhập lại khoá |
| Báo "quá N lần trong một phút" (HTTP 429) | Giới hạn tần suất | Chờ hết thời gian ghi trong `Retry-After`, hoặc nới bằng `RATE_*` trong `.env` |
| Trang trắng, console báo "Refused to … Content Security Policy" | Một tài nguyên mới không nằm trong CSP | Thêm nguồn đó vào `securityHeaders()` trong `server/security.js`; tạm thời có thể bỏ dòng `app.use(securityHeaders…)` |
| Giao diện tối nhấp nháy sáng khi mở trang | Đã build lại nhưng chưa khởi động lại server | Khởi động lại server |
| Học viên báo "Hãy đổi mật khẩu tạm" | Admin vừa đặt lại mật khẩu cho họ | Đăng nhập rồi đổi mật khẩu (đúng thiết kế) |
