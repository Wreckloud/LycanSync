ALTER TABLE chat_message DROP CONSTRAINT ck_chat_message_type;
ALTER TABLE chat_message ADD CONSTRAINT ck_chat_message_type CHECK (type IN ('TEXT', 'IMAGE', 'FILE'));

CREATE TABLE chat_file_attachment (
    id UUID PRIMARY KEY,
    message_id UUID NOT NULL UNIQUE REFERENCES chat_message(id) ON DELETE CASCADE,
    upload_id UUID NOT NULL UNIQUE,
    file_name VARCHAR(255) NOT NULL,
    byte_size BIGINT NOT NULL,
    CONSTRAINT ck_chat_file_attachment_byte_size CHECK (byte_size >= 0)
);

CREATE TABLE chat_file_storage_quota (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    used_bytes BIGINT NOT NULL CHECK (used_bytes >= 0),
    reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes >= 0)
);
INSERT INTO chat_file_storage_quota (id, used_bytes, reserved_bytes) VALUES (1, 0, 0);

CREATE TABLE chat_file_upload_reservation (
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL,
    byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
    created_at TIMESTAMPTZ NOT NULL
);

CREATE FUNCTION release_chat_file_storage_on_delete() RETURNS trigger AS $$
BEGIN
    UPDATE chat_file_storage_quota
    SET used_bytes = used_bytes - OLD.byte_size
    WHERE id = 1;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_chat_file_storage_on_delete
AFTER DELETE ON chat_file_attachment
FOR EACH ROW EXECUTE FUNCTION release_chat_file_storage_on_delete();
