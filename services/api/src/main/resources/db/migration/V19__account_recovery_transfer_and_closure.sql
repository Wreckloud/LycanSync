ALTER TABLE app_user ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE UNIQUE INDEX ix_single_active_administrator ON app_user(administrator)
    WHERE administrator = TRUE AND deleted_at IS NULL;

ALTER TABLE system_state
    ADD COLUMN owner_recovery_user_id UUID REFERENCES app_user(id),
    ADD COLUMN owner_recovery_hash VARCHAR(256),
    ADD COLUMN transfer_target_user_id UUID REFERENCES app_user(id),
    ADD COLUMN transfer_expires_at TIMESTAMPTZ;
ALTER TABLE system_state ADD CONSTRAINT ck_owner_recovery_pair
    CHECK ((owner_recovery_user_id IS NULL) = (owner_recovery_hash IS NULL));
ALTER TABLE system_state ADD CONSTRAINT ck_owner_transfer_pair
    CHECK ((transfer_target_user_id IS NULL) = (transfer_expires_at IS NULL));
