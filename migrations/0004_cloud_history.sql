PRAGMA defer_foreign_keys = ON;

ALTER TABLE chats RENAME TO chats_v3;

CREATE TABLE chats (
  user_id TEXT NOT NULL,
  generation TEXT NOT NULL DEFAULT 'legacy',
  id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  title TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  body_key TEXT,
  PRIMARY KEY (user_id, generation, id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO chats
  (user_id, generation, id, revision, title, pinned, created_at, updated_at, data_json, body_key)
SELECT user_id, 'legacy', id, 1, title, 0, created_at, updated_at, data_json, NULL
FROM chats_v3;

DROP TABLE chats_v3;
CREATE INDEX chats_user_updated_idx ON chats(user_id, updated_at DESC);

PRAGMA defer_foreign_keys = OFF;

CREATE TABLE cloud_history (
  user_id TEXT PRIMARY KEY NOT NULL,
  generation TEXT NOT NULL DEFAULT 'legacy',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO cloud_history (user_id, generation, revision)
SELECT id, 'legacy', 1 FROM users;

CREATE TABLE chat_files (
  user_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (user_id, generation, chat_id, file_id),
  FOREIGN KEY (user_id, generation, chat_id)
    REFERENCES chats(user_id, generation, id) ON DELETE CASCADE
);

CREATE INDEX chat_files_user_file_idx ON chat_files(user_id, file_id);

CREATE TABLE cloud_chat_refs (
  user_id TEXT NOT NULL,
  body_key TEXT NOT NULL,
  file_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, body_key, file_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX cloud_chat_refs_user_created_idx
  ON cloud_chat_refs(user_id, created_at);

INSERT OR IGNORE INTO chat_files (user_id, generation, chat_id, file_id)
SELECT DISTINCT
  chat.user_id,
  chat.generation,
  chat.id,
  json_extract(referenced.value, '$.id')
FROM chats chat
JOIN json_each(chat.data_json, '$.messages') message
JOIN json_each(message.value, '$.files') referenced
WHERE chat.generation = 'legacy'
  AND json_type(chat.data_json, '$.messages') = 'array'
  AND json_type(message.value, '$.files') = 'array'
  AND json_type(referenced.value, '$.id') = 'text';

CREATE TABLE cloud_imports (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  generation TEXT NOT NULL,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
  status TEXT NOT NULL DEFAULT 'staging'
    CHECK (status IN ('staging', 'committed', 'cancelled')),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX cloud_imports_user_status_idx
  ON cloud_imports(user_id, status, updated_at);

CREATE TABLE cloud_uploads (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'file')),
  object_id TEXT NOT NULL,
  generation TEXT,
  import_id TEXT,
  base_revision INTEGER,
  r2_key TEXT NOT NULL,
  multipart_id TEXT NOT NULL,
  summary_json TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  mime_type TEXT,
  completed_revision INTEGER,
  status TEXT NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading', 'completing', 'completed', 'failed', 'cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX cloud_uploads_user_status_idx
  ON cloud_uploads(user_id, status, updated_at);

CREATE TABLE cloud_upload_parts (
  user_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number >= 1),
  etag TEXT NOT NULL,
  PRIMARY KEY (user_id, upload_id, part_number),
  FOREIGN KEY (user_id, upload_id)
    REFERENCES cloud_uploads(user_id, id) ON DELETE CASCADE
);
