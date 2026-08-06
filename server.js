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
  res.send('FFmpeg API サーバー（詳細コーデック・フォーマット補正対応版）は正常稼働中です。');
});

function runSafeCommand(cmd, args, timeoutMs = 150000) {
  return new Promise((resolve) => {
    console.log(`[EXEC] ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    
    let stderrData = '';
    let isFinished = false;

    const timer = setTimeout(() => {
      if (!isFinished) {
        console.warn(`[TIMEOUT] 強制中断: ${cmd}`);
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

  // クレンジング処理： "avi,avi" などのカンマ区切り重複や不要文字を除去
  let rawFormat = req.body.format || 'mp4';
  const cleanFormat = rawFormat.split(',')[0].trim().toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';

  const resolution = req.body.resolution || 'original'; //例: '320x240', '720p'
  const framerate = req.body.framerate || 'original';   //例: '12'
  const vcodec = req.body.vcodec || '';                 //例: 'mjpeg', 'h264'
  const acodec = req.body.acodec || '';                 //例: 'pcm_s16le', 'aac'
  const videoBitrate = req.body.videoBitrate || '';     //例: '640k'
  const audioBitrate = req.body.audioBitrate || '';     //例: '32k'
  const sampleRate = req.body.sampleRate || '';         //例: '8000'

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

    // STEP 1: ExifTool 事前クレンジング (失敗時は無視)
    const preExifArgs = ['-overwrite_original', '-all=', '-tagsFromFile', inputPath, '-all:all', inputPath];
    await runSafeCommand('exiftool', preExifArgs, 15000);

    // STEP 2: FFmpeg コマンドの動的構築
    const ffmpegArgs = [
      '-y',
      '-nostdin',
      '-fflags', '+genpts+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-i', inputPath
    ];

    // 映像コーデック
    if (vcodec) {
      ffmpegArgs.push('-c:v', vcodec);
    } else if (cleanFormat === 'avi') {
      ffmpegArgs.push('-c:v', 'mjpeg'); // AVI指定時、未指定ならMJPEG
    } else if (cleanFormat === 'webm') {
      ffmpegArgs.push('-c:v', 'libvpx-vp9');
    } else {
      ffmpegArgs.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    }

    // 解像度の設定 (320x240 形式 または 1080p などの表記に対応)
    if (resolution.includes('x')) {
      ffmpegArgs.push('-vf', `scale=${resolution.replace('x', ':')}`);
    } else if (resolution === '1080p') {
      ffmpegArgs.push('-vf', 'scale=-2:1080');
    } else if (resolution === '720p') {
      ffmpegArgs.push('-vf', 'scale=-2:720');
    } else if (resolution === '480p') {
      ffmpegArgs.push('-vf', 'scale=-2:480');
    }

    // フレームレートの設定
    if (framerate !== 'original' && !isNaN(framerate)) {
      ffmpegArgs.push('-r', framerate);
    }

    // 映像ビットレート
    if (videoBitrate) {
      ffmpegArgs.push('-b:v', videoBitrate);
    }

    // 音声コーデック
    if (acodec) {
      ffmpegArgs.push('-c:a', acodec);
    } else if (cleanFormat === 'avi') {
      ffmpegArgs.push('-c:a', 'pcm_s16le'); // AVI指定時、未指定ならPCM
    } else if (cleanFormat === 'webm') {
      ffmpegArgs.push('-c:a', 'libopus');
    } else {
      ffmpegArgs.push('-c:a', 'aac');
    }

    // 音声サンプリングレート (例: 8000Hz)
    if (sampleRate && !isNaN(sampleRate)) {
      ffmpegArgs.push('-ar', sampleRate);
    }

    // 音声ビットレート
    if (audioBitrate) {
      ffmpegArgs.push('-b:a', audioBitrate);
    }

    // フォーマット固有の最適化
    if (cleanFormat === 'mp4' || cleanFormat === 'mov') {
      ffmpegArgs.push('-movflags', '+faststart');
    }

    ffmpegArgs.push(ffmpegOutputPath);

    const ffmpegResult = await runSafeCommand('ffmpeg', ffmpegArgs, 150000);

    if (!fs.existsSync(ffmpegOutputPath) || fs.statSync(ffmpegOutputPath).size === 0) {
      throw new Error(`FFmpeg 変換失敗: ${ffmpegResult.stderr.slice(-400)}`);
    }

    // STEP 3: MP4/MOVの場合の ExifTool 後処理
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
    console.error(`[${timestamp}] 変換処理失敗:`, err.message);
    cleanup();
    return res.status(500).json({
      error: '動画の変換処理に失敗しました。設定値の組み合わせを確認してください。',
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API Server Active on Port ${PORT}`));

