CREATE TABLE auth_qq_identity (
    app_id VARCHAR(20) NOT NULL,
    open_id CHAR(32) NOT NULL,
    user_id UUID NOT NULL UNIQUE REFERENCES app_user(id) ON DELETE CASCADE,
    nickname VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (app_id, open_id)
);
