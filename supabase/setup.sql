-- Chạy trong SQL Editor của Supabase project Free.
-- Bật Anonymous Sign-ins và Realtime trong dashboard trước khi chơi.
-- Chỉ tài khoản đã xác thực (kể cả anonymous) được dùng topic game.
-- Mã phòng và pairing token phải được giữ bí mật với người không tham gia.
drop policy if exists "game topics read" on realtime.messages;
drop policy if exists "game topics write" on realtime.messages;

create policy "game topics read" on realtime.messages
  for select to authenticated
  using (realtime.topic() like 'game:room:%' or realtime.topic() like 'game:pair:%');

create policy "game topics write" on realtime.messages
  for insert to authenticated
  with check (realtime.topic() like 'game:room:%' or realtime.topic() like 'game:pair:%');
