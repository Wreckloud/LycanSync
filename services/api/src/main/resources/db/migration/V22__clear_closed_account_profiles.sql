UPDATE app_user
SET nickname = '账号已注销', avatar = '', signature = ''
WHERE deleted_at IS NOT NULL;
