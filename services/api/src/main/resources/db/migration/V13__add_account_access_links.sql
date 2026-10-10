CREATE SEQUENCE account_guest_number START WITH 1001;
CREATE TABLE auth_access_link (
    id UUID PRIMARY KEY,
    token_hash CHAR(64) NOT NULL UNIQUE,
    kind VARCHAR(12) NOT NULL CHECK (kind IN ('ACTIVATE', 'INVITE', 'RECOVERY')),
    creator_id UUID REFERENCES app_user(id) ON DELETE CASCADE,
    target_id UUID REFERENCES app_user(id) ON DELETE CASCADE,
    note VARCHAR(100) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    result_user_id UUID REFERENCES app_user(id) ON DELETE CASCADE,
    redemption_key_hash CHAR(64),
    last_failure VARCHAR(100),
    last_failure_at TIMESTAMPTZ,
    CHECK (expires_at > created_at),
    CHECK ((kind = 'RECOVERY') = (target_id IS NOT NULL))
);
CREATE INDEX ix_auth_access_link_created ON auth_access_link(created_at DESC);
CREATE UNIQUE INDEX ix_auth_single_activation ON auth_access_link(kind)
    WHERE kind = 'ACTIVATE' AND consumed_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX ix_auth_single_recovery ON auth_access_link(target_id)
    WHERE kind = 'RECOVERY' AND consumed_at IS NULL AND revoked_at IS NULL;
