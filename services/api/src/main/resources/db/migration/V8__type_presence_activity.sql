UPDATE user_presence
SET activity_name = NULL,
    activity_started_at = NULL;

ALTER TABLE user_presence
    ADD COLUMN activity_type VARCHAR(16),
    ADD CONSTRAINT ck_user_presence_activity CHECK (
        (activity_type IS NULL AND activity_name IS NULL AND activity_started_at IS NULL)
        OR (activity_type IN ('GAME') AND activity_name IS NOT NULL AND activity_started_at IS NOT NULL)
    );
