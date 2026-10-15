# Run Car

Game đua xe arcade 3D trên trình duyệt. Chơi đơn luôn khả dụng. Phòng riêng tối đa 6 người và điện thoại làm vô lăng dùng Supabase Free để trao đổi tín hiệu, còn chuyển động xe truyền qua WebRTC DataChannel. Đây là game chơi cùng bạn bè, không có máy chủ chống gian lận hoặc bảo đảm kết nối trên mọi mạng.

## Chạy trên máy

Yêu cầu Node.js 20.19+ hoặc 22.12+ (khuyên dùng Node 24) và npm. Trong thư mục repo:

```bash
npm ci
npm run dev
```

Mở địa chỉ Vite in trên terminal. `npm run typecheck` kiểm tra TypeScript; `npm run build` tạo bản phát hành trong `dist/`; `npm run preview` chạy thử bản build. Không cần Supabase cho chơi đơn. Giao diện sẽ hiện **“Chưa cấu hình multiplayer”** khi thiếu URL hoặc key.

Điều khiển máy tính: WASD hoặc phím mũi tên để lái; Space để phanh tay/drift; R để đưa xe về đường. Trên màn hình cảm ứng có nút ga, phanh, drift và rẽ. Chọn **Chơi đơn** để bắt đầu cuộc đua 3 vòng. Đường đua có rào chắn, cọc tiêu, thùng chắn vật lý, chướng ngại di động, vùng trơn và vùng giảm tốc.

## Kết nối Supabase Free

1. Tạo project ở [Supabase](https://supabase.com/). Chọn gói **Free**, không bật billing hay nâng cấp.
2. Trong **Authentication → Providers**, bật **Anonymous Sign-ins**.
3. Trong **SQL Editor**, chạy [supabase/setup.sql](supabase/setup.sql) để cho phép tài khoản anonymous dùng private Realtime channels có topic `game:room:` và `game:pair:`. Realtime phải được bật cho project.
4. Lấy Project URL và **publishable key** từ Project Settings/API. Sao chép `.env.example` thành `.env` và đặt `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. `VITE_SUPABASE_ANON_KEY` chỉ là tên cũ có thể dùng nếu thiếu publishable key. Khởi động lại Vite sau khi đổi file.
5. Hai người có thể vào cùng phòng bằng mã 20 ký tự do host tạo. Host bắt đầu khi mọi người sẵn sàng.

Các biến `VITE_*` được đóng vào JavaScript công khai khi build. Publishable key được thiết kế cho client, nhưng **phải** có chính sách RLS thích hợp. Không dùng service-role hoặc secret key trên trình duyệt. Không đưa dữ liệu nhạy cảm vào kênh game. Tên hiển thị và mã phòng là dữ liệu duy nhất của người chơi được gửi trong phiên; vị trí xe và phòng không được lưu lâu dài. Mã phòng cần giữ kín. Chính sách SQL chỉ giới hạn loại topic và yêu cầu tài khoản đã xác thực; người biết mã phòng vẫn có thể vào phòng. Giới hạn 6 người được kiểm tra ở client, không phải giới hạn có bảo đảm từ server.

## Dùng điện thoại làm vô lăng

Trên máy tính chọn **Kết nối điện thoại** và quét QR bằng camera mặc định của điện thoại. QR mở chính trang game với đường dẫn và base path hiện tại. Pairing token được tạo ngẫu nhiên trên máy tính, có hiệu lực 2 phút và chỉ chấp nhận một thiết bị; QR không chứa key Supabase. Điện thoại kết nối cùng private Realtime channel để trao đổi WebRTC offer/answer/ICE, sau đó gửi ga, phanh và góc lái qua DataChannel. Bấm **Bật cảm biến nghiêng** trên điện thoại để cấp quyền (nếu trình duyệt yêu cầu), dùng **Hiệu chỉnh tư thế thẳng**, độ nhạy, dead zone và làm mượt. Nếu cảm biến không có, dùng ◀ ▶. Nếu P2P thất bại, máy tính vẫn dùng bàn phím/nút cảm ứng.

HTTPS là cần thiết cho cảm biến trên điện thoại; GitHub Pages cung cấp HTTPS. Có thể đổi danh sách STUN công khai bằng `VITE_STUN_URLS` (nhiều URL cách nhau bằng dấu phẩy). Mặc định: `stun:stun.l.google.com:19302`. Không có TURN; NAT, tường lửa hoặc mạng di động có thể khiến P2P không kết nối. Không dùng TURN trả phí và không tự chuyển sang dịch vụ tính phí.

## Xuất bản bằng GitHub Pages

1. Đẩy repo công khai lên GitHub. Vào **Settings → Pages → Build and deployment**, chọn **GitHub Actions**.
2. Nếu dùng multiplayer, vào **Settings → Secrets and variables → Actions → Variables** để đặt `VITE_SUPABASE_URL` và `VITE_SUPABASE_PUBLISHABLE_KEY`. Có thể đặt `VITE_STUN_URLS`. Đây là biến public được gắn vào bản build; đừng đặt service-role key. Nếu không cấu hình, bản Pages vẫn chơi đơn được.
3. Push lên `main` hoặc chạy workflow thủ công. Workflow `.github/workflows/pages.yml` chạy `npm ci`, `npm run build` và deploy `dist`.

Vite tự đặt base `/<tên-repo>/` từ `GITHUB_REPOSITORY` trong GitHub Actions. Trang điện thoại dùng query parameter trên cùng trang nên vẫn hoạt động dưới base path đó. Rapier WebAssembly và thư viện được đóng gói trong build, không tải qua CDN runtime.

GitHub Pages và Supabase Free đều có quota và điều khoản có thể thay đổi. Nếu Supabase hết quota hoặc lỗi, giao diện báo lỗi và chế độ chơi đơn vẫn dùng được; ứng dụng không tự nâng cấp gói. Không cần tên miền, API, tài sản, VPS hoặc billing trả phí.

## Dịch vụ và thư viện

| Thành phần | Vai trò | Chi phí/giấy phép |
| --- | --- | --- |
| GitHub repo công khai + GitHub Pages | Mã nguồn và web tĩnh | Gói miễn phí, theo giới hạn GitHub |
| Supabase Free | Anonymous Auth, Realtime Presence/Broadcast | Gói miễn phí có quota |
| Google public STUN (có thể đổi) | Thử thiết lập WebRTC P2P | Không có bảo đảm truy cập; không dùng TURN |
| Three.js | Render 3D | MIT |
| `@dimforge/rapier3d-compat` | Vật lý và WebAssembly | Apache-2.0 |
| `@supabase/supabase-js` | Auth và Realtime | MIT |
| `qrcode` | Tạo QR tại trình duyệt | MIT |
| Vite, TypeScript | Build và kiểm tra kiểu | MIT và Apache-2.0 |

Xe và cảnh quan được dựng từ hình học Three.js, không dùng tài sản trả phí. Mọi người tự tính vật lý ở client; người chơi có thể gian lận hoặc gửi trạng thái sai. Trò chơi không phải mô phỏng đua xe chuyên nghiệp.
