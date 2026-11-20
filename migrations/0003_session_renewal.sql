ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE auth_sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_sessions ADD COLUMN absolute_expires_at INTEGER NOT NULL DEFAULT 0;

-- 旧会话没有凭据版本和绝对期限，撤销后要求重新登录，保留用户与聊天记录。
DELETE FROM auth_sessions;

-- 密码和账户状态的任何更新都推进版本，阻止更新前开始的登录创建有效会话。
CREATE TRIGGER users_auth_version_after_update
AFTER UPDATE OF password_hash, status ON users
BEGIN
  UPDATE users SET auth_version = OLD.auth_version + 1 WHERE id = NEW.id;
END;
