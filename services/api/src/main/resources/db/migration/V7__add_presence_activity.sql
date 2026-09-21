ALTER TABLE user_presence
    ADD COLUMN activity_name VARCHAR(80),
    ADD COLUMN activity_started_at TIMESTAMPTZ;
