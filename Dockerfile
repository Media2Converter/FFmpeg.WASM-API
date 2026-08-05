FROM node:20-slim

# Linuxパッケージの更新と FFmpeg および ExifTool (libimage-exiftool-perl) のインストール
RUN apt-get update && \
    apt-get install -y ffmpeg libimage-exiftool-perl && \
    rm -rf /var/lib/apt/lists/*

# 作業ディレクトリの設定
WORKDIR /app

# パッケージ情報のコピーと依存ライブラリのインストール
COPY package*.json ./
RUN npm install --production

# ソースコード全体をコピー
COPY . .

# サーバーポートの公開
EXPOSE 3000

# サーバーの起動
CMD ["node", "server.js"]

