-- 历史邀请码只保存了哈希，无法恢复原码；新增密文列保留原有记录和使用次数。
ALTER TABLE invites ADD COLUMN code_ciphertext TEXT;
