ALTER TABLE cloud_imports ADD COLUMN archive_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cloud_imports ADD COLUMN archive_ready INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cloud_imports ADD COLUMN total_sessions INTEGER;
ALTER TABLE cloud_imports ADD COLUMN total_files INTEGER;

CREATE TABLE cloud_archive_files (
  user_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, import_id, file_id),
  FOREIGN KEY (user_id, import_id) REFERENCES cloud_imports(user_id, id) ON DELETE CASCADE
);
