INSERT INTO chat_file_storage_quota (id, used_bytes, reserved_bytes)
SELECT 1,
       (SELECT COALESCE(SUM(byte_size), 0) FROM chat_file_attachment),
       (SELECT COALESCE(SUM(byte_size), 0) FROM chat_file_upload_reservation)
ON CONFLICT (id) DO NOTHING;
