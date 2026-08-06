FROM node:20-slim

# Linux パッケージの更新および FFmpeg, ExifTool のインストール
RUN apt-get update && \
    apt-get install -y ffmpeg libimage-exiftool-perl && \
    rm -rf /var/lib/apt/lists/*

# 作業ディレクトリの指定
WORKDIR /app

# 依存関係のコピーと全パッケージ（devDependencies含む）のインストール
COPY package*.json ./
RUN npm install

# ソースコード全体のコピー
COPY . .

# ビルド時に ESLint による自動コード検査を実行（構文エラー等があればここでビルド停止）
RUN npm run lint

# サーバーポートの開放
EXPOSE 3000

# サーバーの起動コマンド
CMD ["node", "server.js"]

