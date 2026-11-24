-- 原码用于管理员查看和复制；注册继续使用 code_hash，保留所有使用次数和有效期。
ALTER TABLE invites ADD COLUMN code TEXT;
