const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();

// アップロード用一時ディレクトリの作成確認
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

// CORSの許可設定（Lovableや各種Webクライアントからの接続を許可）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ヘルスチェック用エンドポイント
app.get('/', (req, res) => {
  res.send('FFmpeg 変換 API サーバーは正常に稼働しています。');
});

// 動画変換APIエンドポイント
app.post('/api/convert', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルがアップロードされていません。' });
  }

  const inputPath = req.file.path;
  const outputPath = path.join(uploadDir, `output_${Date.now()}.avi`);

  // 最新化されたFFmpegコマンド
  const ffmpegCmd = `ffmpeg -y -nostdin -err_detect careful -ignore_unknown -max_error_rate 1.0 -fflags +discardcorrupt+genpts+igndts -i "${inputPath}" -c:v mjpeg -pix_fmt yuv420p -aspect 9:16 -b:v 640k -r 12.5 -fps_mode cfr -c:a pcm_u8 -b:a 40k -ac 1 -ar 14592 -vf "scale=w='trunc(256/2)*2':h='trunc(144/2)*2':force_original_aspect_ratio=decrease,pad=w='trunc(256/2)*2':h='trunc(144/2)*2':x='(ow-iw)/2':y='(oh-ih)/2':color=black,setsar=1" -af aresample=async=1 -max_muxing_queue_size 9999 -fflags +genpts -avoid_negative_ts make_zero "${outputPath}"`;

  exec(ffmpegCmd, (error, stdout, stderr) => {
    if (error) {
      console.error('FFmpeg 実行エラー:', stderr);
      // 一時ファイルの削除
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      return res.status(500).json({ error: '動画の変換処理に失敗しました。', details: stderr });
    }

    // 変換完了後のAVIファイルをレスポンスとして送信
    res.download(outputPath, 'output.avi', (err) => {
      if (err) {
        console.error('ファイル送信エラー:', err);
      }
      // 送信完了後に一時ファイルを削除（ストレージ圧迫防止）
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`変換サーバーが起動しました: http://localhost:${PORT}`);
});

