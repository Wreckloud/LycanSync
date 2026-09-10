CREATE TABLE system_state (
    id SMALLINT PRIMARY KEY,
    initialized_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT ck_system_state_singleton CHECK (id = 1)
);

INSERT INTO system_state (id, initialized_at)
VALUES (1, NULL);

CREATE TABLE app_user (
    id UUID PRIMARY KEY,
    nickname VARCHAR(32) NOT NULL,
    avatar TEXT NOT NULL,
    administrator BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE auth_local_credential (
    username VARCHAR(32) PRIMARY KEY,
    password_hash VARCHAR(100) NOT NULL,
    user_id UUID NOT NULL UNIQUE REFERENCES app_user(id),
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_auth_local_username_lowercase CHECK (username = lower(username))
);

CREATE TABLE auth_session (
    token_hash CHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES app_user(id),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ix_auth_session_expiry ON auth_session(expires_at);
