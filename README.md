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
| 融資 | 設定頁開啟後買進以融資整張為主（上市六成、上櫃五成），利息按日計，維持率低於追繳線自動斷頭 |
| 點任一列股票 | 個股明細：價格 / MA 圖、RSI / KD、指標、新聞、手動下單 |

命令列：

```bash
node src/cli.js cycle              # 跑一輪，只建議
node src/cli.js cycle --execute    # 跑一輪並模擬成交
node src/cli.js backtest 2330,2317,2454 1000000 120            # 最近 120 個交易日
node src/cli.js backtest 2330,2317,2454 1000000 2025-01-01:2025-06-30   # 指定時間段（迄日可省略）
```

## 決策邏輯：六位分析師 + 投資長

`src/analysts/` 每位分析師各自讀資料、給 -2 ～ +2 分數與信心和理由；
投資長（`analysts/index.js`）依權重加權成 -8 ～ +8 綜合分數，再交給 `strategy.js` 依風控產生買賣。

| 分析師 | 預設權重 | 看什麼 | 資料來源 |
|---|---|---|---|
| 技術線型 | 35% | 均線排列與斜率、MA 交叉、MACD、RSI、KD、量價、20 日突破、布林 | 證交所／櫃買日線 + 即時報價 |
| 籌碼 | 20% | 三大法人近 5／10 日買賣超、外資與投信連續天數、買賣超占成交量、融資融券變化 | 證交所 T86、櫃買法人日報、MI_MARGN |
| 基本面 | 15% | 月營收年增／月增／累計、本益比、淨值比、殖利率 | 證交所／櫃買 openapi |
| 總經 | 15% | 加權指數、費半、S&P 500、VIX、台幣匯率、美債殖利率、總經新聞 | 證交所即時指數 + Yahoo Finance |
| 情緒 | 15% | 個股新聞情緒與熱度、市場新聞情緒、VIX、極端超買超賣反向 | Google 新聞 RSS |
| 投顧 | 15% | 投顧老師最近一週對大盤與個股的看法（Claude 整理） | YouTube / Podcast RSS + 自動字幕 |

權重可在設定調整。綜合分數 ≥ 買進門檻買進，≤ 賣出門檻賣出；另有停損、停利減碼、
單一持股上限、保留現金、持股檔數上限、加碼冷卻期、最小下單金額等風控。
每檔的六個分數顯示在「訊號與決策」表，點進個股可看每位分析師的理由。

### 投顧觀點（`src/advisors.js`）

來源寫在 `DEFAULT_ADVISORS`：請支援輸贏（林睿閎 John 的頻道）、給通勤族的飆股報告書、游庭皓的財經皓角、股癌（Podcast）。
流程：抓各來源 RSS 最近 7 天、每來源最多 4 集 → 本機有 `yt-dlp` 時抓 YouTube 自動字幕（每輪最多 3 部，YouTube 對字幕限流很兇）
→ 交給 Claude（預設 `claude-sonnet-5-5`）整理成每集重點、提到的個股與立場、大盤分數、追蹤清單裡被點名標的的分數 → 快取 12 小時。
結果顯示在側欄「投顧最新觀點」，也會進投資委員會與投資長對話的背景。

- 字幕：`pip install --user yt-dlp`。雲端（Vercel）抓不到字幕，只看標題與說明；在本機跑
  `npm run advisors-push`（.env 需有 `APP_URL`、`CRON_SECRET`）會把字幕推到雲端，之後雲端分析就有完整內容。
  建議放進 crontab，一天三次（台北 07:40、12:30、18:30）：
  `40 7,12 * * 1-5 cd /home/guerrilla/kuang-stock && npm run advisors-push >> data/advisors-push.log 2>&1`
  （GitHub Actions 的機器被 YouTube 擋，連 RSS 都 404，所以不能用它代跑。）
- 股癌是純音訊、說明欄多為業配，目前只有標題，要有內容需接語音轉文字服務。
- 個股沒被點名時，投顧分數只帶入大盤看法的一半、信心 0.25；完全沒資料則跳過不加權。

## 融資

設定頁「融資」區塊開啟後：
- 系統、AI 與投資長的買進決策都以融資整張為主（不足一張退回現股零股），現金只付自備款（成交金額 × (1 − 成數) + 手續費）；融資金額以千元為單位無條件捨去。
- 利息按日累計（年利率 ÷ 365），賣出時依比例扣掉並計入已實現損益；總資產 = 現金 + 持股市值 − 融資餘額 − 未付利息。
- 整戶維持率 = 融資持股市值 ÷ 融資餘額；低於追繳線（預設 130%）時下一輪會先斷頭虧損最大的融資持股（可關閉只警示）。
- 手動下單有「融資」勾選；設定頁的持股表可填現有的融資金額；回測與自動調參也會套用融資設定，結果多一塊「融資」統計（斷頭次數、追繳天數、利息）。

回測只用技術線型分析師（籌碼、基本面、新聞沒有歷史快照）。時間段可以用天數或起迄日期指定；證交所歷史價沒有還原分割（0050 於 2025-06-18 一拆四），回測載入時會自動還原。

## AI 分析師（可選）

兩種方式：

1. 設定環境變數 `ANTHROPIC_API_KEY` 後重啟伺服器，在設定勾選「AI 分析師」。
   引擎會把快照交給 Claude（預設 `claude-opus-5-5`），取回結構化決策；
   停損仍由規則強制執行。
2. 在 Claude Code 裡執行 `/analyze`：投資長會平行派出 `.claude/agents/` 的五個 sub-agent
   （technical / fundamental / chips / macro / sentiment），各自用 taiwan-stock MCP、證交所 API
   與網路搜尋做深入分析，回傳 JSON 後綜合寫出 `data/ai_decisions.json`，
   再執行 `node src/cli.js cycle --execute` 模擬成交。決策檔 30 分鐘內有效。

## 跟投資長對話

右下角「💬 投資長」。背景是最近一輪分析（委員會討論、各標的指標與新聞）加上帳戶與風控參數，
由 Claude 串流回答（預設 `claude-opus-5-5`，effort low；可在 state 的 `config.chat.model` / `effort` 覆寫）。
背景放在 system 並開 prompt cache，同一輪分析內連續對話只付一次完整輸入。對話存在 state（最多 80 則），手機與電腦共用。
投資長不會直接下單，建議操作時會請你按「分析並模擬下單」或手動下單。

投資長可以直接動設定（在對話裡講就好，改完頁面會自動更新，系統日誌會記一筆）：
- 追蹤清單：新增、移除、整份換掉（例如「鎖定 AI 族群」他會自己挑代表性標的並查代碼）
- 風控：停損、停利、單一持股上限、每筆比例、保留現金、買賣門檻、持股檔數、冷卻天數；可要求「停損固定」，之後自動調參不會改它
- 六位分析師權重
- 改融資設定（開關、成數、利率、追繳維持率、自動斷頭）
- 查歷史走勢（加權指數、台指期近月連續、費半、S&P 500、VIX、美元台幣、個股；天數或起迄日期）
- 回測（預設最近 240 個交易日，也可以講時間段像「跑 2025 上半年」；雲端最多 10 檔、250 天；只用技術線型分析師）

他不能下單、不能開關自動執行，這兩件事要在頁面上做。

## 從外部連線（內網）

伺服器綁在所有網路介面（`*:8787`），同網段直接用 `http://<本機IP>:8787`。
要從另一個網段進來，在路由器／DUT 設 NAT port forwarding 到本機的 8787，
並開啟 masquerade（SNAT）以免回程封包走錯路。改 port：`PORT=9000 npm start`。
本機預設不需登入；在 `.env` 設 `APP_PASSWORD` 後所有頁面與 API 都要登入。

## 部署到 Vercel（手機不用 VPN）

架構：GitHub → Vercel（`api/[a].js` 與 `api/[a]/[b].js` 兩支 function 共用 `src/vercel-handler.js` 提供 API，`public/` 當靜態檔，
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
curl -s "https://<app>/api/health?probe=1"   # backend 要是 "redis"（"memory" 代表 Redis 還沒接，資料不會保存）；twse 要是 "ok ..."
curl -s -X POST https://<app>/api/cycle -H "Authorization: Bearer <CRON_SECRET>" -d '{}'
#   盤後回 {"ran":false,"reason":"今日收盤輪次已執行"} 或 "非交易時段" 都算正常；盤中會真的跑一輪
curl -s https://<app>/api/quotes?symbols=2330 --cookie "ks_session=..."   # 確認證交所從 Vercel 抓得到
```

### 雲端限制

- Function 區域設在東京 `hnd1`（`vercel.json`，可改 `hkg1`）。部署後先開「個股明細」確認證交所資料正常；
  若被擋，換區域或改走 Vercel 以外的常駐主機。
- 回測／自動調參在雲端限制為 10 檔、250 個交易日、8 組；完整規模請在本機 `npm run backtest`。
- `.claude/agents` 與 `/analyze`（Claude Code sub-agent）只在本機使用，雲端只有規則引擎與 Claude API 分析師。
- 投顧字幕雲端抓不到，要靠本機 `npm run advisors-push` 推上去；沒推的話雲端只看標題與說明。
- GitHub 排程可能延遲幾分鐘；repo 60 天沒 commit 排程會被 GitHub 停用，重新啟用即可。
- Redis 模式下頁面設定與排程輪次若同時寫入，以後寫入者為準（單人使用不影響）。

## 資料來源

- 即時報價、指數：`mis.twse.com.tw`（約 5 秒更新，無需金鑰）
- 日線、三大法人、融資融券、本益比、月營收：`www.twse.com.tw`、`openapi.twse.com.tw`（上市）、`www.tpex.org.tw`（上櫃），快取在 `data/cache/`
- 臺指期日盤／夜盤近月（對結算價漲跌、期現價差）：`mis.taifex.com.tw`，快取 3 分鐘
- 美股指數、費半、VIX、美元指數、匯率、美債：Yahoo Finance chart API（日線）
- S&P 500 與那斯達克期貨、台積電 ADR、NVIDIA、Apple、AMD、美光、博通：Yahoo Finance 5 分 K 含盤前盤後，快取 10 分鐘
- 新聞：Google 新聞 RSS（繁中 / 台灣）
- 投顧：YouTube 頻道 RSS（`youtube.com/feeds/videos.xml`）與 SoundOn Podcast RSS；字幕用 `yt-dlp`（本機）

## 檔案

```
src/twse.js        證交所 / 櫃買 資料層
src/indicators.js  SMA EMA RSI MACD KD 布林 ATR
src/news.js        新聞抓取與關鍵字情緒
src/analysts/      六位分析師 + 投資長加權（technical / fundamental / chips / macro / sentiment / advisor / index）
src/advisors.js    投顧來源 RSS、yt-dlp 字幕、Claude 整理
scripts/advisors-push.mjs  本機把字幕推上雲端
src/yahoo.js       國際市場（指數日線 + 期貨／美股含盤前盤後）
src/taifex.js      期交所臺指期日盤／夜盤
src/strategy.js    依綜合分數與風控產生買賣決策
src/portfolio.js   帳本：成交、費用、估值
src/engine.js      一輪流程 + 自動排程（autoTick：本機 setInterval 與雲端 cron 共用）
src/analyst.js     Claude API 分析師 / 外部決策通道
src/chat.js        投資長對話（背景整理 + Claude 串流）
src/storage.js     儲存 adapter：Upstash Redis（雲端）或 data/（本機）
src/routes.js      共用路由表 + 登入／排程驗證
src/auth.js        密碼登入、HMAC 簽章 cookie（Node 與 Edge 共用）
api/[a].js, api/[a]/[b].js   Vercel function（單層／兩層路徑，共用 src/vercel-handler.js）
middleware.js      Vercel Edge：未登入導向 /login.html
scripts/migrate-state.mjs  把 data/state.json 匯入 Redis
.github/workflows/cycle.yml  排程呼叫 /api/cycle
.claude/agents/    Claude Code sub-agent 定義（/analyze 使用）
src/backtest.js    歷史回測
src/history.js     指數／台指期／國際市場／個股日線歷史（投資長查走勢用）
src/server.js      本機 HTTP 伺服器（靜態頁 + API + 排程）
public/            前端（無框架）
data/state.json    帳戶狀態（git 忽略）
```

## 注意

這是模擬工具，不是投資建議。規則策略參數是起點，預設在近期震盪盤的回測輸給買進持有，
請用回測面板調整門檻與風控後再開自動模擬。
