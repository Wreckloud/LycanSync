UPDATE user_presence
SET status = 'ONLINE'
WHERE status IN ('DND', 'INVISIBLE');

ALTER TABLE user_presence
    DROP CONSTRAINT ck_user_presence_status,
    DROP COLUMN rich_presence,
    ADD CONSTRAINT ck_user_presence_status CHECK (status IN ('ONLINE', 'AWAY', 'OFFLINE'));

DROP INDEX IF EXISTS ix_user_presence_status_last_seen;
