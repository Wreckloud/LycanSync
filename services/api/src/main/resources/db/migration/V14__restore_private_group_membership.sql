CREATE TABLE group_member (
    group_id UUID NOT NULL REFERENCES chat_group(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_user(id),
    joined_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX ix_group_member_user ON group_member(user_id, joined_at, group_id);
-- 测试阶段的全员访问不转换成真实授权；保留群主、群资料和历史消息。
INSERT INTO group_member(group_id, user_id, joined_at)
SELECT id, owner_user_id, created_at FROM chat_group;
ALTER TABLE chat_group ADD COLUMN invite_code VARCHAR(32) UNIQUE;
ALTER TABLE chat_group ADD COLUMN rtc_room_key UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX ux_chat_group_rtc_room_key ON chat_group(rtc_room_key);
