ALTER TABLE chat_file_storage_quota
    ADD COLUMN max_file_bytes BIGINT CHECK (max_file_bytes > 0),
    ADD COLUMN max_storage_bytes BIGINT CHECK (max_storage_bytes >= max_file_bytes);

CREATE TABLE chat_file_delivery (
    message_id UUID PRIMARY KEY REFERENCES chat_message(id) ON DELETE CASCADE,
    attempt_id UUID NOT NULL UNIQUE,
    file_name VARCHAR(255) NOT NULL,
    byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
    pending_until TIMESTAMPTZ NOT NULL
);
