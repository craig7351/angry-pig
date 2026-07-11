-- Angry Pig 後端 D1 結構（全球排行榜）
-- 套用：wrangler d1 execute angry-pig-db --file=./schema.sql --remote

-- 每場得分紀錄（依 score 排行）
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  name TEXT,
  level TEXT,
  score INTEGER DEFAULT 0,
  note TEXT,          -- 額外資訊（不影響排名）：死鬥/快樂＝波數；飛高＝模式
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores (score DESC);
-- 分關排行榜/名次查詢用（依 level 過濾 + 依 score 排序），降低 rows_read
CREATE INDEX IF NOT EXISTS idx_scores_level_score ON scores (level, score DESC);

-- 速率限制：key（action:ip）最後一次寫入時間
CREATE TABLE IF NOT EXISTS rate (
  k TEXT PRIMARY KEY,
  last_at INTEGER NOT NULL
);

-- 在線（心跳）：近 90 秒活躍裝置
CREATE TABLE IF NOT EXISTS presence (
  device_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presence_seen ON presence (last_seen);

-- 每日上線尖峰人數（day = floor(ms/86400000)），供 7 天折線
CREATE TABLE IF NOT EXISTS online_daily (
  day INTEGER PRIMARY KEY,
  peak INTEGER NOT NULL
);

-- 留言板（parent_id 有值＝回覆）
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  text TEXT,
  device_id TEXT,
  created_at INTEGER,
  parent_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages (id DESC);

-- 全服累計統計（單列 id=1）：遊玩場次 / 消滅動物數 / 遊玩秒數
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY,
  plays INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO stats (id) VALUES (1);
-- 既有資料庫補欄位（新欄位；已存在會報錯可忽略）：
-- ALTER TABLE stats ADD COLUMN kills INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE stats ADD COLUMN seconds INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE scores ADD COLUMN note TEXT;
