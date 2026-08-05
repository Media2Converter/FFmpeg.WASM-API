const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();

// アップロード・変換用一時ディレクトリの準備
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

// CORS許可設定
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ヘルスチェック
app.get('/', (req, res) => {
  res.send('FFmpeg + ExifTool メタデータ修復対応 API サーバーは稼働中です。');
});

// 補助関数: コマンド実行をPromise化 (タイムアウト付き)
function runCommand(cmd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stderr });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// 動画変換APIエンドポイント
app.post('/api/convert', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルがアップロードされていません。' });
  }

  const timestamp = Date.now();
  const inputPath = req.file.path;
  const sanitizedInputPath = path.join(uploadDir, `sanitized_${timestamp}.mp4`);
  const ffmpegOutputPath = path.join(uploadDir, `ffmpeg_out_${timestamp}.mp4`);
  const finalOutputPath = path.join(uploadDir, `output_${timestamp}.mp4`);

  // クリーンアップ用ヘルパー
  const cleanup = () => {
    [inputPath, sanitizedInputPath, ffmpegOutputPath, finalOutputPath].forEach((filePath) => {
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) { /* 無視 */ }
      }
    });
  };

  try {
    console.log(`[${timestamp}] 処理開始: ${req.file.originalname}`);

    // STEP 1: ExifTool で入力ファイルの破損・不適合メタデータを安全に整形/事前修復
    // 不正なメタデータタグを除去し、標準的なデータ構造を準備します
    const preExifCmd = `exiftool -overwrite_original -all= -tagsFromFile "${inputPath}" -all:all "${inputPath}" || true`;
    await runCommand(preExifCmd, 30000).catch(err => console.warn('事前Exif処理警告 (続行可能):', err.stderr));

    // STEP 2: FFmpeg による強力な堅牢変換
    // -err_detect ignore_err : 壊れたフレームを無理に処理せず読み飛ばす
    // -movflags +faststart  : ヘッダー(moov)を先頭に配置（iPhone用高速読み込み）
    // -pix_fmt yuv420p      : iOS規格必須のピクセルフォーマット
    const ffmpegCmd = `ffmpeg -y -err_detect ignore_err -i "${inputPath}" -c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart "${ffmpegOutputPath}"`;
    
    console.log(`[${timestamp}] FFmpeg 変換実行中...`);
    await runCommand(ffmpegCmd, 180000); // 3分タイムアウト

    // STEP 3: 変換後の動画に iPhone/QuickTime 完全対応のメタデータを ExifTool で注入
    console.log(`[${timestamp}] iPhone用 Exif メタデータ注入中...`);
    const postExifCmd = `exiftool -overwrite_original_in_place -out "${finalOutputPath}" ` +
      `-MajorBrand="mp42" ` +
      `-MinorVersion="1" ` +
      `-CompatibleBrands="mp41,mp42,isom,avc1" ` +
      `-HandlerName="Core Media Video" ` +
      `-Encoder="Apple QuickTime" ` +
      `"${ffmpegOutputPath}"`;

    await runCommand(postExifCmd, 30000);

    // 成功時: 完了したファイルをダウンロード返却
    const targetFile = fs.existsSync(finalOutputPath) ? finalOutputPath : ffmpegOutputPath;
    
    res.download(targetFile, 'output.mp4', (err) => {
      if (err) console.error('ファイル送信エラー:', err);
      cleanup();
    });

  } catch (err) {
    console.error(`[${timestamp}] 処理例外エラー:`, err);
    cleanup();
    return res.status(500).json({
      error: '動画の修復・変換処理に失敗しました。ファイルが高度に破損している可能性があります。',
      details: err.stderr || err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`変換サーバー(ExifTool連動版)が起動しました: http://localhost:${PORT}`);
});

