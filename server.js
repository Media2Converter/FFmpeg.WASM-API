const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => {
  res.send('FFmpeg + ExifTool 安全エラーハンドリング対応 API サーバーは正常稼働中です。');
});

// コマンド安全実行関数 (spawn使用でデッドロックとフリーズを防止)
function runSafeCommand(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    console.log(`[EXEC] ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    
    let stderrData = '';
    let isFinished = false;

    const timer = setTimeout(() => {
      if (!isFinished) {
        console.warn(`[TIMEOUT] 命令が指定時間(${timeoutMs}ms)内に応答しないため強制中断します: ${cmd}`);
        proc.kill('SIGKILL');
      }
    }, timeoutMs);

    proc.stdout.on('data', () => {}); // バッファ解放のため空読み
    proc.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    proc.on('close', (code) => {
      isFinished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true, stderr: stderrData });
      } else {
        console.warn(`[WARN] コマンド終了コード ${code}: ${stderrData.slice(-300)}`);
        resolve({ success: false, stderr: stderrData });
      }
    });

    proc.on('error', (err) => {
      isFinished = true;
      clearTimeout(timer);
      console.error(`[ERROR] プロセス起動失敗: ${err.message}`);
      resolve({ success: false, stderr: err.message });
    });
  });
}

app.post('/api/convert', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルがアップロードされていません。' });
  }

  const format = req.body.format || 'mp4';
  const resolution = req.body.resolution || 'original';
  const framerate = req.body.framerate || 'original';
  const audioBitrate = req.body.audioBitrate || '128k';

  const timestamp = Date.now();
  const inputPath = req.file.path;
  const ffmpegOutputPath = path.join(uploadDir, `ffmpeg_${timestamp}.${format}`);
  const finalOutputPath = path.join(uploadDir, `output_${timestamp}.${format}`);

  const cleanup = () => {
    [inputPath, ffmpegOutputPath, finalOutputPath].forEach((filePath) => {
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
    });
  };

  try {
    console.log(`[${timestamp}] 変換リクエスト開始: ${req.file.originalname} (${format})`);

    // STEP 1: ExifTool 事前メタデータクレンジング (失敗しても止まらず次へフォールバック)
    const preExifArgs = ['-overwrite_original', '-all=', '-tagsFromFile', inputPath, '-all:all', inputPath];
    await runSafeCommand('exiftool', preExifArgs, 15000);

    // STEP 2: FFmpeg 頑丈変換コマンド構築
    const ffmpegArgs = [
      '-y',
      '-nostdin',                         // 対話モード無効化（フリーズ防止）
      '-fflags', '+genpts+discardcorrupt', // 壊れたフレーム・PTSを補正して通過
      '-err_detect', 'ignore_err',        // エラー無視で処理継続
      '-i', inputPath
    ];

    // 解像度フィルターの設定
    if (resolution === '1080p') ffmpegArgs.push('-vf', 'scale=-2:1080');
    else if (resolution === '720p') ffmpegArgs.push('-vf', 'scale=-2:720');
    else if (resolution === '480p') ffmpegArgs.push('-vf', 'scale=-2:480');

    // フレームレート設定
    if (framerate !== 'original' && !isNaN(framerate)) {
      ffmpegArgs.push('-r', framerate);
    }

    // コーデック設定
    if (format === 'webm') {
      ffmpegArgs.push('-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-b:a', audioBitrate);
    } else {
      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', audioBitrate,
        '-max_muxing_queue_size', '1024',
        '-movflags', '+faststart'
      );
    }

    ffmpegArgs.push(ffmpegOutputPath);

    // FFmpeg 実行 (最大150秒)
    const ffmpegResult = await runSafeCommand('ffmpeg', ffmpegArgs, 150000);

    // FFmpeg 出力ファイルの存在確認
    if (!fs.existsSync(ffmpegOutputPath) || fs.statSync(ffmpegOutputPath).size === 0) {
      throw new Error(`FFmpeg 変換失敗: ${ffmpegResult.stderr.slice(-300)}`);
    }

    // STEP 3: ExifTool による iPhone 向け最適化タグの付与 (失敗しても無視して FFmpeg 出力を返却)
    if (format === 'mp4' || format === 'mov') {
      const postExifArgs = [
        '-overwrite_original_in_place',
        '-out', finalOutputPath,
        '-MajorBrand=mp42',
        '-MinorVersion=1',
        '-CompatibleBrands=mp41,mp42,isom,avc1',
        '-HandlerName=Core Media Video',
        '-Encoder=Apple QuickTime',
        ffmpegOutputPath
      ];
      await runSafeCommand('exiftool', postExifArgs, 20000);
    }

    // 最終的に存在するファイルを選択
    const sendFilePath = fs.existsSync(finalOutputPath) && fs.statSync(finalOutputPath).size > 0 
      ? finalOutputPath 
      : ffmpegOutputPath;

    res.download(sendFilePath, `output.${format}`, (err) => {
      if (err) console.error('レスポンス送信エラー:', err);
      cleanup();
    });

  } catch (err) {
    console.error(`[${timestamp}] エラー判定により中断:`, err.message);
    cleanup();
    return res.status(500).json({
      error: '動画の変換処理に失敗しました。ファイル破損が深刻か、サポートされていないコーデックです。',
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Careful対応サーバーが起動しました: http://localhost:${PORT}`);
});

