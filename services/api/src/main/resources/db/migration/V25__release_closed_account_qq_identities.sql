DELETE FROM auth_qq_identity binding
USING app_user account
WHERE binding.user_id = account.id AND account.deleted_at IS NOT NULL;
