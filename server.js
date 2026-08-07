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

// 日本時間 (JST) 営業時間制御 (06:00 〜 23:00)
const checkBusinessHours = (req, res, next) => {
  const nowJST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const hour = nowJST.getHours();

  if (hour < 6 || hour >= 23) {
    if (req.path === '/api/convert') {
      return res.status(403).json({
        error: 'サーバの営業時間が終了しました。',
        details: '本サーバーの作戦運用時間は 06:00 〜 23:00 です。'
      });
    }
  }
  next();
};

// 全CORS通信の完全許可 (CORSエラー・通信失敗の防止)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Expose-Headers', 'Content-Disposition');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use(checkBusinessHours);

// サーバー直接アクセス時の表示画面 (弾薬モード・ダーク背景・白文字)
app.get('/', (req, res) => {
  const nowJST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const hour = nowJST.getHours();
  const isWorking = (hour >= 6 && hour < 23);

  const html = `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>FFmpeg API サーバー - 弾薬モード</title>
      <style>
        body {
          background-color: #121411;
          color: #ffffff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
          text-align: center;
        }
        .card {
          background: #1c201a;
          padding: 32px 24px;
          border-radius: 12px;
          border: 2px solid #3b4438;
          box-shadow: 0 12px 40px rgba(0,0,0,0.8);
          max-width: 400px;
          width: 90%;
        }
        h1 { font-size: 20px; color: #d4af37; margin-bottom: 12px; }
        p { font-size: 14px; color: #f0f2ee; margin: 8px 0; }
        .badge {
          display: inline-block;
          padding: 8px 18px;
          border-radius: 6px;
          font-weight: bold;
          font-size: 13px;
          margin-top: 16px;
        }
        .open { background: #193822; color: #81c784; border: 1px solid #2e5c38; }
        .closed { background: #3d1c1d; color: #e57373; border: 1px solid #6b2d2f; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>FFmpeg API サーバー</h1>
        ${isWorking 
          ? '<p>GitHubサーバーは正常に作戦稼働中です。</p><div class="badge open">● 営業時間内 (06:00〜23:00)</div>' 
          : '<p>サーバの営業時間が終了しました。</p><div class="badge closed">● 営業時間外 (06:00〜23:00)</div>'}
      </div>
    </body>
    </html>
  `;
  res.status(200).send(html);
});

function runSafeCommand(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    console.log(`[EXEC] ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    
    let stderrData = '';
    let isFinished = false;

    const timer = setTimeout(() => {
      if (!isFinished) {
        console.warn(`[TIMEOUT] プロセス中断: ${cmd}`);
        proc.kill('SIGKILL');
      }
    }, timeoutMs);

    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    proc.on('close', (code) => {
      isFinished = true;
      clearTimeout(timer);
      resolve({ success: code === 0, stderr: stderrData });
    });

    proc.on('error', (err) => {
      isFinished = true;
      clearTimeout(timer);
      resolve({ success: false, stderr: err.message });
    });
  });
}

app.post('/api/convert', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルがアップロードされていません。' });
  }

  let rawFormat = req.body.format || 'mp4';
  const cleanFormat = rawFormat.split(',')[0].trim().toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';

  const resolution = req.body.resolution || 'original';
  const framerate = req.body.framerate || 'original';
  const vcodec = req.body.vcodec || '';
  const acodec = req.body.acodec || '';

  const timestamp = Date.now();
  const inputPath = req.file.path;
  const ffmpegOutputPath = path.join(uploadDir, `ffmpeg_${timestamp}.${cleanFormat}`);
  const finalOutputPath = path.join(uploadDir, `output_${timestamp}.${cleanFormat}`);

  const cleanup = () => {
    [inputPath, ffmpegOutputPath, finalOutputPath].forEach((filePath) => {
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
    });
  };

  try {
    console.log(`[${timestamp}] 変換要求: ${req.file.originalname} -> ${cleanFormat}`);

    // STEP 1: ExifTool 処理
    const preExifArgs = ['-overwrite_original', '-all=', '-tagsFromFile', inputPath, '-all:all', inputPath];
    await runSafeCommand('exiftool', preExifArgs, 15000);

    // STEP 2: FFmpeg 変換
    const ffmpegArgs = [
      '-y',
      '-nostdin',
      '-fflags', '+genpts+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-i', inputPath
    ];

    if (vcodec) {
      ffmpegArgs.push('-c:v', vcodec);
    } else if (cleanFormat === 'avi') {
      ffmpegArgs.push('-c:v', 'mjpeg');
    } else if (cleanFormat === 'webm') {
      ffmpegArgs.push('-c:v', 'libvpx-vp9');
    } else {
      ffmpegArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    }

    if (resolution.includes('x')) {
      ffmpegArgs.push('-vf', `scale=${resolution.replace('x', ':')}`);
    } else if (resolution === '1080p') {
      ffmpegArgs.push('-vf', 'scale=-2:1080');
    } else if (resolution === '720p') {
      ffmpegArgs.push('-vf', 'scale=-2:720');
    } else if (resolution === '480p') {
      ffmpegArgs.push('-vf', 'scale=-2:480');
    }

    if (framerate !== 'original' && !isNaN(framerate)) {
      ffmpegArgs.push('-r', framerate);
    }

    if (acodec) {
      ffmpegArgs.push('-c:a', acodec);
    } else if (cleanFormat === 'avi') {
      ffmpegArgs.push('-c:a', 'pcm_s16le');
    } else if (cleanFormat === 'webm') {
      ffmpegArgs.push('-c:a', 'libopus');
    } else {
      ffmpegArgs.push('-c:a', 'aac');
    }

    if (cleanFormat === 'mp4' || cleanFormat === 'mov') {
      ffmpegArgs.push('-movflags', '+faststart');
    }

    ffmpegArgs.push(ffmpegOutputPath);

    const ffmpegResult = await runSafeCommand('ffmpeg', ffmpegArgs, 180000);

    if (!fs.existsSync(ffmpegOutputPath) || fs.statSync(ffmpegOutputPath).size === 0) {
      throw new Error(`FFmpeg 変換失敗: ${ffmpegResult.stderr.slice(-300)}`);
    }

    // STEP 3: ExifTool 後処理
    if (cleanFormat === 'mp4' || cleanFormat === 'mov') {
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

    const sendFilePath = fs.existsSync(finalOutputPath) && fs.statSync(finalOutputPath).size > 0 
      ? finalOutputPath 
      : ffmpegOutputPath;

    res.download(sendFilePath, `output.${cleanFormat}`, (err) => {
      if (err) console.error('送信エラー:', err);
      cleanup();
    });

  } catch (err) {
    console.error(`[${timestamp}] エラー:`, err.message);
    cleanup();
    return res.status(500).json({
      error: '動画の変換処理に失敗しました。',
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

