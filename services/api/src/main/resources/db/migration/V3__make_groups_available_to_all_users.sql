ALTER TABLE chat_group
    ADD COLUMN owner_user_id UUID REFERENCES app_user(id);

UPDATE chat_group AS g
SET owner_user_id = member.user_id
FROM group_member AS member
WHERE member.group_id = g.id AND member.role = 'OWNER';

ALTER TABLE chat_group
    ALTER COLUMN owner_user_id SET NOT NULL;

DROP TABLE group_member;
