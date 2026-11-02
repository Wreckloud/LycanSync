-- 连续核对合并为一个区间；失联后另起区间，不将停机空档计入累计。
CREATE TABLE rtc_voice_time (
    participant_sid VARCHAR(80) PRIMARY KEY,
    room_sid VARCHAR(80) NOT NULL,
    user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    confirmed_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    observing BOOLEAN NOT NULL,
    connected_periods TSTZMULTIRANGE NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_rtc_voice_time_user_room ON rtc_voice_time(user_id, room_sid);
CREATE INDEX ix_rtc_voice_time_observing ON rtc_voice_time(room_sid) WHERE observing;
