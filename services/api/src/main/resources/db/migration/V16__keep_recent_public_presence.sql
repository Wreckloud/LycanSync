ALTER TABLE user_presence
    ADD COLUMN show_activity BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN show_last_online BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN last_online_at TIMESTAMPTZ,
    ADD COLUMN recent_game_name VARCHAR(80),
    ADD COLUMN recent_game_ended_at TIMESTAMPTZ,
    ADD COLUMN recent_game_played_seconds BIGINT,
    ADD CONSTRAINT ck_recent_presence_game CHECK (
        (recent_game_name IS NULL AND recent_game_ended_at IS NULL AND recent_game_played_seconds IS NULL)
        OR (recent_game_name IS NOT NULL AND recent_game_ended_at IS NOT NULL
            AND recent_game_played_seconds IS NOT NULL AND recent_game_played_seconds > 0)
    );

-- 离线心跳也持续写 last_seen_at，不能拿旧离线记录推断最后公开在线时间。
UPDATE user_presence SET last_online_at = last_seen_at WHERE status <> 'OFFLINE';
