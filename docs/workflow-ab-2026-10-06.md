# So sánh A/B: dịch tuyến tính và dịch theo đồ thị (2026-10-06)

Model: `meta/llama-3.1-8b-instruct` (Metta-AI-Server). 9 đoạn của sách #1, chọn rải theo độ dài (433–2494 ký tự). Chạy trên bản sao DB, không lưu (`server/workflow/compare.js`). Bảng thuật ngữ gieo thử 7 mục lấy từ kho từ vựng (attachment, peers, peer orientation…).

| Đoạn | Ký tự | Tuyến tính: lỗi | ms | Đồ thị: lỗi | ms | Lượt AI | Đường đi |
|---|---|---|---|---|---|---|---|
| #13 | 601 | — | 17110 | — | 17602 | 1 | single → verify → persist |
| #121 | 433 | bold | 13991 | — | 13989 | 2 | single → verify → repair → repairText → verify → persist |
| #196 | 657 | bold | 10042 | — | 10905 | 2 | single → verify → repair → repairText → verify → persist |
| #11 | 842 | — | 25556 | — | 24065 | 1 | single → verify → persist |
| #103 | 961 | bold | 13442 | — | 11875 | 2 | single → verify → repair → repairText → verify → persist |
| #178 | 778 | bold | 12294 | — | 18375 | 2 | single → verify → repair → repairText → verify → persist |
| #68 | 1739 | sentences | 72699 | — | 31219 | 3 | chunked → verify → repair → repairText → verify → persist |
| #82 | 2116 | glossary, glossary, untranslated, bold | 34534 | — | 59997 | 6 | chunked → verify → repair → repairText → verify → persist |
| #95 | 2494 | bold | 36386 | — | 50851 | 5 | chunked → verify → repair → repairText → verify → persist |

**Tổng:** tuyến tính 2/9 đoạn qua kiểm tra, 236 s, 9 lượt gọi AI · đồ thị 9/9, 239 s, 24 lượt gọi AI.

## Đọc văn bản, không chỉ điểm

Điểm do chính bộ kiểm tra (`checks.js`) chấm — cũng là thứ đồ thị sửa theo — nên nghiêng về đồ thị. Đọc đối chiếu:

- **Thật sự tốt hơn:** đoạn dài với model 8B. #68 (20 câu): tuyến tính mất 7 câu; đồ thị chia đoạn, đủ câu, nhanh hơn (31 s so với 73 s). #82: tuyến tính sót "whisper", bôi đậm hỏng (`****whisper…****`), không theo thuật ngữ.
- **Phần lớn chênh lệch còn lại là bôi đậm lệch** giữa hai cột (6/10 lỗi của tuyến tính) — đồ thị căn lại được, nhưng đó là lỗi hình thức.
- **Không bắt được lỗi nghĩa:** "whisper" → "thở nhẹ", "sticking out the tongue" → "nhổ mồm", "polarity shifting" → "sự dịch chuyển cực đoan của bản chất lưỡng cực" vẫn còn ở cả hai cách. Cần model lớn hơn hoặc người đọc duyệt (luồng thảo luận).
- **Lượt 1 lộ ra 2 lỗi của đồ thị, đã sửa:** (1) đoạn có ghi chú tiếng Việt lẫn trong cột tiếng Anh → mảnh đó bị model "dịch" bằng cách chép đoạn trước, thêm 2 câu không có trong bản gốc; nay mảnh không phải tiếng Anh bị bỏ qua và có kiểm tra "thêm câu thừa". (2) dịch các mảnh song song làm xưng hô lệch giữa các mảnh ("mình"/"bạn"); nay dịch lần lượt, mảnh sau lấy mảnh trước làm ngữ cảnh. (3) khi sửa thuật ngữ, model chép nguyên lời giải thích dài của mục glossary vào câu; nay chỉ yêu cầu cách dịch chính.
- **Chi phí:** 2,7× lượt gọi AI (24 so với 9); thời gian tổng gần bằng nhau vì chia đoạn giúp đoạn dài nhanh hơn. Đoạn không có lỗi đi thẳng `verify → persist`, không tốn thêm.

## Khuyến nghị

Bật "Tự kiểm tra & sửa" khi dùng Metta-AI-Server (model nhỏ): lợi rõ ở đoạn dài và thuật ngữ, chi phí chỉ phát sinh khi có lỗi. Với model lớn (Claude, GPT) nên chạy lại so sánh này trước khi bật mặc định. Mẫu 9 đoạn còn nhỏ; nên chạy thêm trên một chương đầy đủ.
