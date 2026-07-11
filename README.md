# 庫存盤點 — 手機盤點 PWA

供盤點人員在手機瀏覽器使用的離線優先 PWA，直接連 Supabase（不經主系統），支援初盤/複盤、
搜尋品號、掃描條碼、多人即時同步、離線佇列補送。部署於 GitHub Pages：

```
https://pchchung.github.io/stocktake-pwa/
```

完整規格見主系統 repo `stocktake-main` 的 `docs/00_專案總覽.md`（本 repo 只放程式碼）。

## 開發

純靜態網頁（無打包工具），本機測試：

```bash
python -m http.server 5300
```

開 `http://localhost:5300`。

## 設定

`config.js` 裡的 `SUPABASE_URL`／`SUPABASE_ANON_KEY` 設計上是**公開值**（資安靠 Supabase 端
的 Row Level Security），可以安心留在這個 public repo。**絕對不能**把 `service_role` key 或
Postgres 連線字串放進這個 repo 的任何檔案。

## 改版部署

```bash
git add -A && git commit -m "..." && git push
```

推送後 GitHub Pages 約 1 分鐘內自動部署。**務必同步調高 `sw.js` 的 `CACHE_VERSION`**
（例如 `stocktake-v5` → `stocktake-v6`），否則已安裝到手機主畫面的舊版本會一直吃離線快取、
看不到新版程式碼。

## 保活

`.github/workflows/keepalive.yml` 每週一自動 ping Supabase 的 `keepalive` 表，避免免費版
專案閒置 7 天被自動暫停。GitHub 若偵測到 repo 超過 60 天無 commit 會停用排程 workflow，
收到通知信時記得去 Actions 頁面重新啟用。
