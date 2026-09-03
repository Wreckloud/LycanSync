CREATE TABLE system_state (
    id SMALLINT PRIMARY KEY,
    initialized_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT ck_system_state_singleton CHECK (id = 1)
);

INSERT INTO system_state (id, initialized_at)
VALUES (1, NULL);
