# 🚀 機器人啟動教學（Docker）

這份文件教你怎麼把 Discord 機器人用 Docker 掛著跑，只要它在跑，你就能在 Discord 裡使用機器人。

---

## 一、事前準備

啟動前，確認以下東西都就緒：

1. **已安裝 Docker**
   - Mac / Windows：安裝 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 並打開它
   - 確認方式：終端機輸入 `docker --version`，有跑出版本號就代表 OK

2. **已填好 `.env` 檔**（放在專案根目錄，和 `bot.js` 同一層）

   ```env
   # Discord 機器人 token（必填）
   TOKEN=你的_discord_bot_token

   # 管理身分組 ID（會員管理指令要用）
   ADMIN_ROLE_ID=身分組ID

   # keep-alive 用的 port（可選，預設 3000）
   PORT=3000
   ```

   > ⚠️ `.env` 不會被打包進映像檔，token 不會外洩，放心填。

---

## 二、啟動機器人

打開終端機，`cd` 到專案資料夾，執行：

```bash
docker compose up -d --build
```

- `--build`：建置映像檔（第一次、或改過程式碼後要加）
- `-d`：背景執行（關掉終端機也會繼續跑）

第一次會花一點時間下載 Node 映像檔與安裝依賴，之後會很快。

---

## 三、確認機器人有上線

看即時 log：

```bash
docker compose logs -f
```

看到類似 `Logged in as XXX` 或 `Keep-alive server running on port 3000` 就代表成功上線了。
按 `Ctrl + C` 只是離開看 log 畫面，**不會關掉機器人**。

接著回到 Discord，就能正常使用機器人指令了 ✅

---

## 四、常用指令

| 目的 | 指令 |
|------|------|
| 啟動（背景跑） | `docker compose up -d` |
| 改過程式碼後重新啟動 | `docker compose up -d --build` |
| 看即時 log | `docker compose logs -f` |
| 停止機器人 | `docker compose down` |
| 重新啟動 | `docker compose restart` |
| 查看是否在跑 | `docker compose ps` |

---

## 五、關於「掛著跑」

`docker-compose.yml` 裡設定了 `restart: unless-stopped`，意思是：

- 機器人程式當掉 → 自動重啟
- 電腦 / 主機重開機 → Docker 啟動後會自動把機器人拉起來（前提是 Docker Desktop 有跟著開機）

所以只要不主動 `docker compose down`，它就會一直掛著。

> 💡 如果是放在自己電腦跑，電腦關機時機器人就會停。要 24 小時不斷線，建議放到雲端主機（VPS）或 Render 之類的平台。

---

## 六、資料會不會不見？

不會。機器人的狀態（警告、婚姻、禁言等）會存在這幾個檔案：

`warnings.json`、`marriages.json`、`proposals.json`、`divorces.json`、`muted_members.json`

`docker-compose.yml` 已經把它們掛載到主機，所以就算容器重建、重啟，資料都會保留。

---

## 七、遇到問題？

- **機器人沒上線**：先看 `docker compose logs -f`，通常是 `TOKEN` 填錯或沒填。
- **改了程式碼沒生效**：記得加 `--build` 重新建置。
- **port 被佔用**：把 `docker-compose.yml` 裡 `ports:` 那兩行刪掉（自己掛著跑用不到對外 port）。
