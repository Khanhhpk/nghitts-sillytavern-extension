# NghiTTS SillyTavern Extension

![NghiTTS Banner](https://img.shields.io/badge/SillyTavern-Extension-blue?style=for-the-badge&logo=appveyor)
![Status](https://img.shields.io/badge/Status-Stable-brightgreen?style=for-the-badge)
![Platform](https://img.shields.io/badge/Platform-WebAssembly-orange?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-purple?style=for-the-badge)

NghiTTS là một tiện ích mở rộng (Extension) dành riêng cho **SillyTavern**, mang đến khả năng phát âm thanh Text-To-Speech (TTS) Tiếng Việt với độ trễ cực thấp (Zero-Latency) mà **không cần cài đặt phần mềm bên thứ 3** hay **sử dụng API Server bên ngoài**.

Tất cả quá trình tạo giọng nói đều diễn ra hoàn toàn **Offline, cục bộ 100% bên trong trình duyệt của bạn** bằng sức mạnh của WebAssembly (WASM) và ONNX Runtime.

## 🌟 Tính năng nổi bật

- 🚀 **Zero-Latency Progressive Streaming**: Không cần chờ AI đọc xong cả câu! Hệ thống chia nhỏ văn bản và phát âm thanh ngay lập tức ngay khi cụm từ đầu tiên được tạo ra.
- 💻 **Chạy hoàn toàn cục bộ (100% Offline in Browser)**: Model được tải thẳng vào bộ nhớ đệm (Cache) của trình duyệt. Sau lần tải đầu tiên, bạn có thể ngắt mạng và sử dụng vĩnh viễn. Không gửi dữ liệu đi đâu, bảo vệ quyền riêng tư tuyệt đối.
- ⚡ **Kiến trúc Đa luồng (Multi-threading)**: Tích hợp hệ thống Worker Pool, cho phép bạn sử dụng từ 1 đến 8 CPU Workers để tạo âm thanh song song, tận dụng tối đa sức mạnh phần cứng.
- 🇻🇳 **Bộ tiền xử lý Tiếng Việt chuyên dụng (Vietnamese Cleaner)**:
  - Tự động nhận diện và bảo toàn từ vựng Tiếng Việt.
  - Tích hợp bộ quy tắc (Dictionary) mạnh mẽ, bắt chuẩn xác cách phát âm của các cụm từ ngoại lai (ví dụ: `Mahiro` -> `Ma hi rô`).
  - Hỗ trợ tùy chỉnh cấu hình Ngắt nghỉ theo dấu câu hoặc ký hiệu đặc biệt.
- 🧠 **Memory-Leak Proof**: Quản lý rác (Garbage Collection) thông minh, xử lý âm thanh luân phiên qua bộ nhớ đệm giúp RAM luôn ổn định dù chạy qua hàng ngàn trang văn bản.

## 💡 Nguồn gốc Ý tưởng (Credits)

Tiện ích này được lấy cảm hứng và xây dựng dựa trên nền tảng của:
- **[Piper TTS](https://github.com/rhasspy/piper)**: Mô hình Text-to-Speech mã nguồn mở siêu nhanh, nhẹ và chất lượng cao do Rhasspy phát triển.
- **[piper-tts-web](https://github.com/huggingface/piper-tts-web)**: Bản port của Piper TTS lên trình duyệt sử dụng `onnxruntime-web` (WebAssembly), chứng minh tiềm năng của việc chạy các mô hình AI ngôn ngữ ngay trên tab trình duyệt mà không cần Backend.

Dự án NghiTTS đã kế thừa tinh hoa của `piper-tts-web`, tái cấu trúc toàn bộ luồng xử lý Audio Context, xây dựng thêm hệ thống đa luồng (Worker Pool) và bộ phân tách/dịch thuật ngôn ngữ Tiếng Việt để tương thích hoàn hảo với môi trường Roleplay đặc thù của **SillyTavern**.

## 🛠 Hướng dẫn Cài đặt & Sử dụng

### 1. Cài đặt vào SillyTavern
1. Mở SillyTavern, truy cập vào menu **Extensions** (Biểu tượng khối rubik).
2. Chọn **Install Extension** và dán đường link Github của kho lưu trữ này vào.
3. Reload (F5) lại SillyTavern sau khi cài đặt thành công.

### 2. Tải và kích hoạt Model
1. Trong bảng điều khiển của NghiTTS, nhấn nút **Làm mới danh sách (Refresh)** ở mục `Model (Online List)`.
2. Chọn một Model Tiếng Việt từ danh sách thả xuống.
3. Bấm **Tải Model về máy (Offline)**. Lần tải đầu tiên có thể mất vài phút tùy vào tốc độ mạng (Model nặng khoảng 50MB - 100MB).
4. Sau khi báo "Tải thành công", Model sẽ nằm cố định trong mục `Giọng đọc (Đã tải sẵn)`. 
5. Chọn giọng đọc ở mục này và thưởng thức!

### 3. Tinh chỉnh Nâng cao (Tối ưu hiệu năng)
- **Workers**: Nếu máy bạn có CPU mạnh (nhiều nhân), hãy tăng số lượng Worker lên (Khuyên dùng: 2 hoặc 3). Càng nhiều Worker, tốc độ tạo âm thanh càng nhanh, nhưng sẽ tốn nhiều RAM hơn.
- **Từ điển Phát âm**: Nhấn vào nút `Cài đặt Nâng cao` để thêm các từ ngoại lai. Ví dụ: Thêm `Itsuki` -> `ít xu ki`, hệ thống sẽ tự động bắt chữ (không phân biệt hoa/thường) và đọc đúng tiếng Việt.
- **Custom Pause (Ngắt nghỉ)**: Thêm các khoảng lặng có chủ đích vào giữa đoạn hội thoại. Ví dụ: Cho ký hiệu `...` ngưng 0.8 giây để tạo cảm giác ngập ngừng chân thực hơn.

## 🏗 Kiến trúc Hệ thống
- Lõi âm thanh: Web Audio API (`AudioContext`).
- Trình biên dịch AI: `onnxruntime-web` (WASM).
- Giao tiếp đa luồng: `Web Workers` & `postMessage` architecture.
- Gói đóng gói (Bundler): `esbuild`.

## 📜 Giấy phép (License)
Dự án được phân phối dưới giấy phép **MIT License**. Bạn có toàn quyền sử dụng, sửa đổi và phân phối lại mã nguồn. Chi tiết xem tại tệp `LICENSE` (nếu có).
