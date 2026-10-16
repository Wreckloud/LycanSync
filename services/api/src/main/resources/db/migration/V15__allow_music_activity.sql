ALTER TABLE user_presence
    DROP CONSTRAINT ck_user_presence_activity,
    ADD CONSTRAINT ck_user_presence_activity CHECK (
        (activity_type IS NULL AND activity_name IS NULL AND activity_started_at IS NULL)
        OR (activity_type IN ('GAME', 'MUSIC') AND activity_name IS NOT NULL AND activity_started_at IS NOT NULL)
    );
