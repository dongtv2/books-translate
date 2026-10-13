# Thể loại (genre) của sách và kho từ vựng

Trạng thái: phần 1 và 2 xong (2026-10-13).

- **Thể loại** (`genres`, `server/genres.js`): Thiền & Phật pháp, Nuôi dạy con, Tâm lý học,
  Kỹ năng sống, Sức khoẻ (mặc định); biên tập viên (`vocab.edit`) tạo, sửa, xoá, sắp xếp ở
  Kho từ vựng → *Quản lý thể loại*.
- **Sách** có một thể loại: tự động theo từ khoá của thể loại (khớp đầu từ, giữ dấu tiếng Việt —
  "phật" ≠ "phát") trên lĩnh vực / chuyên môn / tên sách, thể loại đứng trước thắng; hoặc chọn tay
  ở trang sách (thanh công cụ mục lục → *Thể loại*). Chọn "Tự động" để trả lại.
- **Từ vựng** thuộc thể loại của các sách nó đến từ (đoạn nguồn, nghĩa riêng theo sách), chỉ tính
  sách người xem được phép thấy. Biên tập viên thêm/bỏ thể loại cho từng từ (`vocab_genres`), ghi
  đè phần tự động; chỉnh về đúng như tự động thì bản ghi chỉnh tay tự xoá.
- Thể loại khác **Chủ đề** (`vocabTopics.js`): chủ đề = nghĩa của từ, thể loại = loại sách.
- API: `GET/POST /api/genres`, `PATCH/DELETE /api/genres/:id`, `PUT /api/vocabulary/:id/genres`,
  `GET /api/vocabulary?genre=<id|none>`, `PATCH /api/books/:id { genre_id: <id|"auto"> }`.
- **AI gợi ý thể loại** (phần 2): trang sách → thanh công cụ mục lục → *Gợi ý thể loại*
  (`POST /api/books/:id/suggest-genre`, quyền `books.edit`). AI đọc tên, lĩnh vực, chuyên môn,
  ghi chú và 3 đoạn đầu sách, phải chọn **một tên trong danh sách thể loại**; tên ngoài danh sách
  chỉ hiện như đề xuất "thể loại mới", không bao giờ thành thể loại. Không tự áp dụng — biên tập
  viên bấm *Áp dụng* (= chọn tay). Dùng nhà cung cấp AI đang chọn trong Cài đặt. Tắt: `GENRE_AI=0`.
- **Từ thuộc nhiều thể loại** (phần 2): Kho từ vựng → chip *Thuộc nhiều thể loại* (`?genre=multi`,
  cũng dùng được khi xuất file/ôn tập); số lượng ở `GET /api/genres` → `multi`.
- Kiểm tra: `npm run test:genres` (10 kiểm tra, trong `npm test`; gợi ý AI thử với một AI giả).

**Khi có lỗi**

| Triệu chứng | Làm gì |
|---|---|
| Sách xếp sai thể loại | Sửa từ khoá / thứ tự thể loại, hoặc chọn tay ở trang sách |
| Một từ sai thể loại | Kho từ vựng → nhãn thể loại của từ → *Sửa* → tick/bỏ tick |
| Cần bỏ hẳn tính năng | Xoá các thể loại (không xoá từ nào, sách về "chưa có thể loại"); dữ liệu nằm riêng trong `genres`, `vocab_genres`, `books.genre_id/genre_manual` |
| Nút *Gợi ý thể loại* báo lỗi 502 | AI chưa sẵn sàng (vd. Metta-AI-Server đang nạp model) hoặc trả sai JSON — thử lại, đổi nhà cung cấp, hoặc chọn tay |
| Muốn tắt gợi ý AI | Đặt `GENRE_AI=0` rồi khởi động lại server (nút trả 503, không mất dữ liệu) |
| Cần quay lại dữ liệu trước | Backup `books-20261013-024620-059-manual.db` (trước khi tạo thể loại) — `npm run db:restore -- <file>` khi server dừng |

Phần 2 không đổi lược đồ dữ liệu; gợi ý AI không ghi gì vào DB cho tới khi bấm *Áp dụng*.
