# kuang-stock 模擬操盤

輸入你的持股與存款，系統每輪抓台股即時報價、算技術指標、讀新聞情緒，
依規則策略（或 Claude AI 分析師）產生買賣決策並做紙上交易，記錄資產曲線。

## 啟動

```bash
npm install
npm start          # http://localhost:8787
```

第一次開啟會跳出「設定」：輸入現金、持股（代碼 / 股數 / 平均成本）、觀察清單，按「套用並重設帳戶」。

## 操作

| 按鈕 | 作用 |
|---|---|
| 分析（不下單） | 抓報價、指標、新聞，只產生建議 |
| 分析並模擬下單 | 同上，並依決策模擬成交（含手續費、證交稅） |
| 設定 → 盤中自動執行 | 開盤時段每 N 分鐘自動跑一輪並下單，收盤後再跑一次 |
| 歷史回測 | 同一套規則在過去日線逐日模擬，與 0050 買進持有比較 |
| 點任一列股票 | 個股明細：價格 / MA 圖、RSI / KD、指標、新聞、手動下單 |

命令列：

```bash
node src/cli.js cycle              # 跑一輪，只建議
node src/cli.js cycle --execute    # 跑一輪並模擬成交
node src/cli.js backtest 2330,2317,2454 1000000 120
```

## 決策邏輯：五位分析師 + 投資長

`src/analysts/` 每位分析師各自讀資料、給 -2 ～ +2 分數與信心和理由；
投資長（`analysts/index.js`）依權重加權成 -8 ～ +8 綜合分數，再交給 `strategy.js` 依風控產生買賣。

| 分析師 | 預設權重 | 看什麼 | 資料來源 |
|---|---|---|---|
| 技術線型 | 35% | 均線排列與斜率、MA 交叉、MACD、RSI、KD、量價、20 日突破、布林 | 證交所／櫃買日線 + 即時報價 |
| 籌碼 | 20% | 三大法人近 5／10 日買賣超、外資與投信連續天數、買賣超占成交量、融資融券變化 | 證交所 T86、櫃買法人日報、MI_MARGN |
| 基本面 | 15% | 月營收年增／月增／累計、本益比、淨值比、殖利率 | 證交所／櫃買 openapi |
| 總經 | 15% | 加權指數、費半、S&P 500、VIX、台幣匯率、美債殖利率、總經新聞 | 證交所即時指數 + Yahoo Finance |
| 情緒 | 15% | 個股新聞情緒與熱度、市場新聞情緒、VIX、極端超買超賣反向 | Google 新聞 RSS |

權重可在設定調整。綜合分數 ≥ 買進門檻買進，≤ 賣出門檻賣出；另有停損、停利減碼、
單一持股上限、保留現金、持股檔數上限、加碼冷卻期、最小下單金額等風控。
每檔的五個分數顯示在「訊號與決策」表，點進個股可看每位分析師的理由。

回測只用技術線型分析師（籌碼、基本面、新聞沒有歷史快照）。

## AI 分析師（可選）

兩種方式：

1. 設定環境變數 `ANTHROPIC_API_KEY` 後重啟伺服器，在設定勾選「AI 分析師」。
   引擎會把快照交給 Claude（預設 `claude-opus-5-5`），取回結構化決策；
   停損仍由規則強制執行。
2. 在 Claude Code 裡執行 `/analyze`：投資長會平行派出 `.claude/agents/` 的五個 sub-agent
   （technical / fundamental / chips / macro / sentiment），各自用 taiwan-stock MCP、證交所 API
   與網路搜尋做深入分析，回傳 JSON 後綜合寫出 `data/ai_decisions.json`，
   再執行 `node src/cli.js cycle --execute` 模擬成交。決策檔 30 分鐘內有效。

## 從外部連線（內網）

伺服器綁在所有網路介面（`*:8787`），同網段直接用 `http://<本機IP>:8787`。
要從另一個網段進來，在路由器／DUT 設 NAT port forwarding 到本機的 8787，
並開啟 masquerade（SNAT）以免回程封包走錯路。改 port：`PORT=9000 npm start`。
本機預設不需登入；在 `.env` 設 `APP_PASSWORD` 後所有頁面與 API 都要登入。

## 部署到 Vercel（手機不用 VPN）

架構：GitHub → Vercel（`api/[...path].js` 一支 catch-all function 提供 API，`public/` 當靜態檔，
`middleware.js` 在 Edge 擋未登入的頁面）＋ Upstash Redis 存狀態與快取 ＋ GitHub Actions 每 5 分鐘呼叫 `/api/cycle`。
程式會自動判斷：有 Redis 環境變數就用 Redis，否則存本機 `data/`，所以本機 `npm start` 照常。

### 一次性設定

1. **推到 GitHub**：`git push origin main`（`.env`、`data/` 已在 `.gitignore`）。
2. **Vercel 匯入 repo**：vercel.com → Add New Project → 選 `kuang-stock`，Framework 選 Other，其餘預設。
3. **建 Redis**：Vercel 專案 → Storage → Marketplace → Upstash Redis → Create 並連到專案，
   會自動注入 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`（或 `KV_REST_API_URL` / `KV_REST_API_TOKEN`，兩種都支援）。
4. **環境變數**（Settings → Environment Variables）：
   - `APP_PASSWORD`：登入密碼（**必填**，沒設的話雲端 API 一律回 503）
   - `CRON_SECRET`：排程密鑰，`openssl rand -hex 32`
   - `ANTHROPIC_API_KEY`：要用 AI 分析師才填
   設完 Redeploy。
5. **匯入目前帳戶**：在本機把 Upstash 的 URL/TOKEN 貼進 `.env`，執行
   ```bash
   npm run migrate-state -- --dry          # 先看會匯入什麼
   npm run migrate-state                   # 匯入；Redis 已有資料時要加 --force
   npm run migrate-state -- --stop-loss 0.08 --auto off   # 可在匯入時改停損或先關自動執行
   ```
   匯完把 `.env` 裡的 Redis 變數拿掉（或留著，本機就會改讀 Redis）。
6. **GitHub Actions 排程**：repo → Settings → Secrets and variables → Actions 加
   `APP_URL`（例 `https://kuang-stock.vercel.app`，不要斜線結尾）與 `CRON_SECRET`（同 Vercel）。
   `.github/workflows/cycle.yml` 會在台北 09:00–13:55 每 5 分鐘、以及 14:15 呼叫一次；
   收盤輪次一天只跑一次（伺服器端以 `lastAutoClose` 與 Redis 鎖防重複）。Actions 頁可用 Run workflow 手動測。

### 驗收

```bash
curl -s https://<app>/api/health                                    # {"ok":true,"backend":"redis","serverless":true}
curl -s -X POST https://<app>/api/cycle -H "Authorization: Bearer <CRON_SECRET>" -d '{}'
#   盤後回 {"ran":false,"reason":"今日收盤輪次已執行"} 或 "非交易時段" 都算正常；盤中會真的跑一輪
curl -s https://<app>/api/quotes?symbols=2330 --cookie "ks_session=..."   # 確認證交所從 Vercel 抓得到
```

### 雲端限制

- Function 區域設在東京 `hnd1`（`vercel.json`，可改 `hkg1`）。部署後先開「個股明細」確認證交所資料正常；
  若被擋，換區域或改走 Vercel 以外的常駐主機。
- 回測／自動調參在雲端限制為 4 檔、120 天、8 組；完整規模請在本機 `npm run backtest`。
- `.claude/agents` 與 `/analyze`（Claude Code sub-agent）只在本機使用，雲端只有規則引擎與 Claude API 分析師。
- GitHub 排程可能延遲幾分鐘；repo 60 天沒 commit 排程會被 GitHub 停用，重新啟用即可。
- Redis 模式下頁面設定與排程輪次若同時寫入，以後寫入者為準（單人使用不影響）。

## 資料來源

- 即時報價、指數：`mis.twse.com.tw`（約 5 秒更新，無需金鑰）
- 日線、三大法人、融資融券、本益比、月營收：`www.twse.com.tw`、`openapi.twse.com.tw`（上市）、`www.tpex.org.tw`（上櫃），快取在 `data/cache/`
- 美股、費半、VIX、匯率、美債：Yahoo Finance chart API
- 新聞：Google 新聞 RSS（繁中 / 台灣）

## 檔案

```
src/twse.js        證交所 / 櫃買 資料層
src/indicators.js  SMA EMA RSI MACD KD 布林 ATR
src/news.js        新聞抓取與關鍵字情緒
src/analysts/      五位分析師 + 投資長加權（technical / fundamental / chips / macro / sentiment / index）
src/yahoo.js       國際市場
src/strategy.js    依綜合分數與風控產生買賣決策
src/portfolio.js   帳本：成交、費用、估值
src/engine.js      一輪流程 + 自動排程（autoTick：本機 setInterval 與雲端 cron 共用）
src/analyst.js     Claude API 分析師 / 外部決策通道
src/storage.js     儲存 adapter：Upstash Redis（雲端）或 data/（本機）
src/routes.js      共用路由表 + 登入／排程驗證
src/auth.js        密碼登入、HMAC 簽章 cookie（Node 與 Edge 共用）
api/[...path].js   Vercel catch-all function
middleware.js      Vercel Edge：未登入導向 /login.html
scripts/migrate-state.mjs  把 data/state.json 匯入 Redis
.github/workflows/cycle.yml  排程呼叫 /api/cycle
.claude/agents/    Claude Code sub-agent 定義（/analyze 使用）
src/backtest.js    歷史回測
src/server.js      本機 HTTP 伺服器（靜態頁 + API + 排程）
public/            前端（無框架）
data/state.json    帳戶狀態（git 忽略）
```

## 注意

這是模擬工具，不是投資建議。規則策略參數是起點，預設在近期震盪盤的回測輸給買進持有，
請用回測面板調整門檻與風控後再開自動模擬。
