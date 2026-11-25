CREATE TABLE diagnostic_report (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_user(id),
    uploaded_at TIMESTAMPTZ NOT NULL,
    json_bytes BIGINT NOT NULL CHECK (json_bytes > 0 AND json_bytes <= 41943040),
    compressed_report BYTEA NOT NULL CHECK (octet_length(compressed_report) BETWEEN 1 AND 8388608)
);
