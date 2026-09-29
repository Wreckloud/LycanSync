ALTER TABLE chat_file_upload_reservation
    ADD COLUMN process_instance_id UUID;

UPDATE chat_file_upload_reservation
SET process_instance_id = '00000000-0000-0000-0000-000000000000'
WHERE process_instance_id IS NULL;

ALTER TABLE chat_file_upload_reservation
    ALTER COLUMN process_instance_id SET NOT NULL;
