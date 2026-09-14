CREATE TABLE chat_message (
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES chat_group(id) ON DELETE CASCADE,
    sender_user_id UUID NOT NULL REFERENCES app_user(id),
    type VARCHAR(16) NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_chat_message_type CHECK (type IN ('TEXT', 'IMAGE')),
    CONSTRAINT ck_chat_message_content_valid CHECK (
        char_length(content) <= 2000 AND (type <> 'TEXT' OR btrim(content) <> '')
    )
);

CREATE TABLE chat_attachment (
    id UUID PRIMARY KEY,
    message_id UUID NOT NULL UNIQUE REFERENCES chat_message(id) ON DELETE CASCADE,
    content_type VARCHAR(32) NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    byte_size INTEGER NOT NULL,
    data BYTEA NOT NULL,
    CONSTRAINT ck_chat_attachment_content_type CHECK (content_type IN ('image/png', 'image/jpeg')),
    CONSTRAINT ck_chat_attachment_dimensions CHECK (width > 0 AND height > 0),
    CONSTRAINT ck_chat_attachment_byte_size CHECK (byte_size > 0)
);

CREATE INDEX ix_chat_message_group_created ON chat_message(group_id, created_at, id);
