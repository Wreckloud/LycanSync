ALTER TABLE chat_group
    ADD COLUMN next_message_sequence BIGINT NOT NULL DEFAULT 1,
    ADD CONSTRAINT ck_chat_group_next_message_sequence_positive CHECK (next_message_sequence > 0);

ALTER TABLE chat_message
    ADD COLUMN sequence_number BIGINT;

WITH ranked_messages AS (
    SELECT id, row_number() OVER (PARTITION BY group_id ORDER BY created_at, id) AS sequence_number
    FROM chat_message
)
UPDATE chat_message AS message
SET sequence_number = ranked_messages.sequence_number
FROM ranked_messages
WHERE ranked_messages.id = message.id;

UPDATE chat_group AS chat_group
SET next_message_sequence = COALESCE((
    SELECT max(message.sequence_number) + 1
    FROM chat_message AS message
    WHERE message.group_id = chat_group.id
), 1);

ALTER TABLE chat_message
    ALTER COLUMN sequence_number SET NOT NULL,
    ADD CONSTRAINT ck_chat_message_sequence_number_positive CHECK (sequence_number > 0),
    ADD CONSTRAINT uq_chat_message_group_sequence UNIQUE (group_id, sequence_number);

DROP INDEX ix_chat_message_group_created;
