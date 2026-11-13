# Zzz

Zzz 是一個在瀏覽器裡跑的免費睡眠聲音監測網站：睡前把手機插著充電、開著網頁，它會學習背景噪音，只記錄超出背景的聲音，醒來後在本機分析。

**零資料收集。** 所有錄音與分析都只在你的裝置上進行，網站不上傳任何資料、不使用分析工具、不載入任何外部資源。

## 開發

需要 Node 22.12 以上(建議 24)與 pnpm 10。

```bash
pnpm install   # 安裝依賴
pnpm dev       # 啟動開發伺服器
pnpm build     # 型別檢查 + 產生 dist/
pnpm check     # build 後用 Chromium 驗證 CSP 與首頁
```

- `pnpm dev` 使用自簽憑證的 HTTPS(麥克風等 API 只在安全連線下可用)。要用手機測試，手機需與電腦在同一個 Wi-Fi,開啟終端機顯示的 `https://<區網 IP>:5173/`;瀏覽器會警告憑證不受信任，選擇繼續即可。
- 第一次在自己電腦跑 `pnpm check` 前，先執行一次 `pnpm exec playwright install chromium`。

## 部署

使用 Cloudflare Pages 連結此 repo:

- `main` 分支為正式站，其他分支會自動產生預覽網址。
- Build command:`pnpm build`
- Build output directory:`dist`

## 自己驗證隱私

網站的回應標頭帶有嚴格的 `Content-Security-Policy`,其中 `connect-src 'self'` 代表頁面只能連回自己的網域，瀏覽器會擋下任何往外送資料的請求。

- 打開瀏覽器 DevTools → Network,點選主文件，查看回應標頭的 `Content-Security-Policy`。
- 或在終端機執行 `curl -sI <網址>`。
