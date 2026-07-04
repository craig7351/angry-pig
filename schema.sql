-- Angry Pig 後端 D1 結構（全球排行榜）
-- 套用：wrangler d1 execute angry-pig-db --file=./schema.sql --remote

-- 每場得分紀錄（依 score 排行）
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  name TEXT,
  level TEXT,
  score INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores (score DESC);

-- 速率限制：key（action:ip）最後一次寫入時間
CREATE TABLE IF NOT EXISTS rate (
  k TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL
);
