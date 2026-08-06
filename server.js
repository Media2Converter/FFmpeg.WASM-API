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

// 強力な CORS 設定（どんなオリジン・プリフライトリクエストもすべて即座に許可）
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

// ヘルスチェックルート（サーバー起爆用）
app.get('/', (req, res) => {
  res.status(200).send('FFmpeg API サーバーは正常稼働中です。');
});

function runSafeCommand(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    console.log(`[EXEC] ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    
    let stderrData = '';
    let isFinished = false;

    const timer = setTimeout(() => {
      if (!isFinished) {
        console.warn(`[TIMEOUT] プロセス強制終了: ${cmd}`);
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

  // 重複パラメータ (例: avi,avi) の自動クレンジング
  let rawFormat = req.body.format || 'mp4';
  const cleanFormat = rawFormat.split(',')[0].trim().toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';

  const resolution = req.body.resolution || 'original';
  const framerate = req.body.framerate || 'original';
  const vcodec = req.body.vcodec || '';
  const acodec = req.body.acodec || '';
  const videoBitrate = req.body.videoBitrate || '';
  const audioBitrate = req.body.audioBitrate || '';
  const sampleRate = req.body.sampleRate || '';

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
    console.log(`[${timestamp}] 変換リクエスト開始: ${req.file.originalname} -> ${cleanFormat}`);

    // STEP 1: ExifTool 事前クレンジング (失敗しても止まらず続行)
    const preExifArgs = ['-overwrite_original', '-all=', '-tagsFromFile', inputPath, '-all:all', inputPath];
    await runSafeCommand('exiftool', preExifArgs, 15000);

    // STEP 2: FFmpeg コマンド組み立て
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

    if (videoBitrate) {
      ffmpegArgs.push('-b:v', videoBitrate);
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

    if (sampleRate && !isNaN(sampleRate)) {
      ffmpegArgs.push('-ar', sampleRate);
    }

    if (audioBitrate) {
      ffmpegArgs.push('-b:a', audioBitrate);
    }

    if (cleanFormat === 'mp4' || cleanFormat === 'mov') {
      ffmpegArgs.push('-movflags', '+faststart');
    }

    ffmpegArgs.push(ffmpegOutputPath);

    const ffmpegResult = await runSafeCommand('ffmpeg', ffmpegArgs, 180000);

    if (!fs.existsSync(ffmpegOutputPath) || fs.statSync(ffmpegOutputPath).size === 0) {
      throw new Error(`FFmpeg 変換失敗: ${ffmpegResult.stderr.slice(-300)}`);
    }

    // STEP 3: ExifTool 後処理 (MP4/MOVの場合)
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
      if (err) console.error('ファイル送信エラー:', err);
      cleanup();
    });

  } catch (err) {
    console.error(`[${timestamp}] 変換エラー:`, err.message);
    cleanup();
    return res.status(500).json({
      error: '動画の変換処理に失敗しました。',
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバーが起動しました: Port ${PORT}`);
});

