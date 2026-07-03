# 使用官方 Node 20 精簡版
FROM node:20-alpine

# 設定容器內工作目錄
WORKDIR /app

# 先只複製套件清單，善用 Docker layer 快取
COPY package.json package-lock.json ./

# 只安裝正式環境依賴（照著 lockfile 精準安裝）
RUN npm ci --omit=dev

# 複製其餘程式碼
COPY . .

# keep-alive 伺服器用的 port（預設 3000）
EXPOSE 3000

# 啟動 bot
CMD ["node", "bot.js"]
