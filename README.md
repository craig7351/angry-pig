# 🐷 Angry Pig — 第一人稱 3D 投擲破壞遊戲

用 **three.js** 渲染、**cannon-es** 3D 物理打造的憤怒鳥風格遊戲。第一人稱瞄準、蓄力丟球，砸垮用木箱／磚牆／貨櫃／沙包搭建的堡壘，把站在上面的動物撞下來摔到地板即消滅。

- 🎮 **線上遊玩（含全球排行榜）:** https://angry-pig.pages.dev

## 玩法

- **移動滑鼠**：環顧瞄準（畫面中央準星）
- **按住左鍵**：蓄力（越久越大力，底部有蓄力條 + 拋物線預測）
- **放開左鍵**：朝準星方向丟球
- **M**：開關背景音樂　**Esc**：返回選單
- 把動物 🐷🐑🐔🐱🐕🦝🐺🐴🐤 撞下箱子摔到地板就消滅；打中爆炸桶 🛢️ / 瓦斯桶 ⛽ 會連環爆
- 後段關卡是**以爆裂物為地基的高樓**：打爆地基 → 爆炸衝擊波掀翻塔基 → 整棟連鎖倒塌
- 過關依剩餘彈藥給 **1~3 星**，星數存於瀏覽器、逐關解鎖，關卡難度與建築複雜度遞增

## 開發

```bash
npm install
npm run dev      # 開發伺服器（http://localhost:5180）
npm run build    # 打包到 dist/
npm run preview  # 預覽打包結果
```

## 技術

| 項目 | 技術 |
|------|------|
| 渲染 | three.js r160（GLTFLoader / SkeletonUtils） |
| 物理 | cannon-es 0.20（3D 剛體、碰撞、休眠） |
| 音效 / 音樂 | Web Audio 即時合成 + 動物死亡音效 die.mp3 |
| 建置 | Vite 5 |
| 後端 | Cloudflare Pages Functions + D1（全球排行榜） |

## 全球排行榜（後端）

首頁需輸入名字才能開始；過關/失敗會把分數送到全球排行榜。後端由 Cloudflare Pages Functions（`functions/api/*`）+ D1 提供，**開發時無 `/api` 會自動回退 localStorage**。

- `functions/api/score.js` — `POST /api/score`（送出得分，含 IP 速率限制）
- `functions/api/leaderboard.js` — `GET /api/leaderboard`（每名玩家取最高分排序）
- `schema.sql` — D1 結構（`scores` / `rate`）

部署（需先 `wrangler login`）：

```bash
wrangler d1 create angry-pig-db          # 建資料庫，把 database_id 填入 wrangler.jsonc
npm run db:init                          # 套用 schema 到遠端 D1
npm run deploy                           # build + 部署到 Cloudflare Pages
```

## 檔案

- `index.html` — 頁面 + HUD + 登入頁 + 選單 + 排行榜彈窗
- `fps.js` — 遊戲主程式（場景、物理、關卡、飛行特效、名字/排行榜、流程）
- `sfx.js` — Web Audio 音效與背景音樂
- `functions/api/` — Cloudflare Pages Functions（排行榜後端）
- `public/assets/` — 模型素材（glTF，皆自包含；放 public 才會打包進 dist）

## 素材

模型來自 minecraft 動物包與環境包（glTF 格式）。動物皆為骨架 + Idle 動畫。
