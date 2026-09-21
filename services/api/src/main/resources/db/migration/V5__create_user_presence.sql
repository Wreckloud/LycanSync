CREATE TABLE user_presence (
    user_id UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL DEFAULT 'ONLINE',
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    rich_presence JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_user_presence_status CHECK (status IN ('ONLINE', 'AWAY', 'DND', 'INVISIBLE', 'OFFLINE'))
);

CREATE INDEX ix_user_presence_status_last_seen ON user_presence(status, last_seen_at);
