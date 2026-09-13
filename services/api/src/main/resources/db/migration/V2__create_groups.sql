CREATE TABLE chat_group (
    id UUID PRIMARY KEY,
    name VARCHAR(32) NOT NULL,
    description VARCHAR(200) NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_chat_group_name_not_blank CHECK (btrim(name) <> '')
);

CREATE TABLE group_member (
    group_id UUID NOT NULL REFERENCES chat_group(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_user(id),
    role VARCHAR(16) NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (group_id, user_id),
    CONSTRAINT ck_group_member_role CHECK (role IN ('OWNER', 'MEMBER'))
);

CREATE UNIQUE INDEX ux_group_member_owner
    ON group_member(group_id)
    WHERE role = 'OWNER';

CREATE INDEX ix_group_member_user
    ON group_member(user_id, joined_at, group_id);
