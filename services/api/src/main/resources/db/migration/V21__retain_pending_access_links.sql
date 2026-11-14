-- 仅服主可再次读取待使用链接；旧记录的摘要不能还原为原始凭据。
ALTER TABLE auth_access_link ADD COLUMN pending_token VARCHAR(43);
