CREATE TABLE auth_qq_configuration (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    enabled BOOLEAN NOT NULL,
    app_id VARCHAR(20) NOT NULL,
    app_key VARCHAR(128) NOT NULL,
    callback_url VARCHAR(2048) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
