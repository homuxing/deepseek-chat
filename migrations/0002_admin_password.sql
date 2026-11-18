ALTER TABLE auth_sessions ADD COLUMN admin_credential_hash TEXT;

-- Invalidate sessions created by the former Access login without deleting user data.
DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE role = 'admin');
DROP TABLE login_handoffs;
