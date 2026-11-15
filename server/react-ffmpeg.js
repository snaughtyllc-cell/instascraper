const { spawn } = require('node:child_process');

function buildFfmpegArgs(opts) {
  const { rawPath, referencePath, outputPath, rawDuration, rawHasAudio, referenceHasAudio,
    crop, syncMs, output, referenceAudio } = opts;
  if (!Number.isFinite(rawDuration) || rawDuration <= 0 ||
      !Number.isInteger(syncMs) || syncMs < -7000 || syncMs > 32000 ||
      !['stitched', 'solo'].includes(output) ||
      !crop || !Number.isFinite(crop.top) || !Number.isFinite(crop.height) ||
      crop.top < 0 || crop.height < 0.2 || crop.top + crop.height > 1 ||
      typeof rawPath !== 'string' || typeof outputPath !== 'string' ||
      (output === 'stitched' && typeof referencePath !== 'string')) {
    throw new Error('invalid_render_options');
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-protocol_whitelist', 'file,pipe', '-i', rawPath];
  const graph = [];
  if (output === 'solo') {
    graph.push('[0:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,' +
      'crop=1080:1920,setsar=1,fps=30[v]');
  } else {
    if (syncMs > 0) args.push('-itsoffset', String(syncMs / 1000));
    if (syncMs < 0) args.push('-ss', String(-syncMs / 1000));
    args.push('-protocol_whitelist', 'file,pipe', '-i', referencePath);
    graph.push('[0:v]setpts=PTS-STARTPTS,scale=1080:960:force_original_aspect_ratio=increase,' +
      'crop=1080:960,setsar=1,fps=30[bot]');
    // Normalize the reference before adding cloned frames: keeping the input
    // offset here as well would apply positive sync twice (also true for audio).
    const startPad = syncMs > 0 ? `,tpad=start_mode=clone:start_duration=${syncMs / 1000}` : '';
    graph.push(`[1:v]setpts=PTS-STARTPTS,crop=iw:ih*${crop.height}:0:ih*${crop.top},` +
      'scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1,fps=30' +
      `${startPad},tpad=stop_mode=clone:stop_duration=600[top]`);
    graph.push('[top][bot]vstack=inputs=2[v]');
  }

  if (rawHasAudio) {
    graph.push(`[0:a]asetpts=PTS-STARTPTS,volume=1.0,apad,atrim=duration=${rawDuration}[mic]`);
  }
  const useReferenceAudio = output === 'stitched' && referenceAudio && referenceHasAudio;
  if (useReferenceAudio) {
    const delay = syncMs > 0 ? `,adelay=${syncMs}:all=1` : '';
    graph.push(`[1:a]asetpts=PTS-STARTPTS${delay},volume=0.8,apad,` +
      `atrim=duration=${rawDuration}[refaudio]`);
  }
  if (rawHasAudio && useReferenceAudio) {
    graph.push('[mic][refaudio]amix=inputs=2:duration=first:normalize=0,alimiter=latency=1[a]');
  } else if (rawHasAudio || useReferenceAudio) {
    graph.push(`[${rawHasAudio ? 'mic' : 'refaudio'}]alimiter=latency=1[a]`);
  } else {
    graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${rawDuration}[a]`);
  }

  args.push('-filter_complex', graph.join(';'), '-map', '[v]', '-map', '[a]',
    '-t', String(rawDuration), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart', outputPath);
  return args;
}

function runProcess(command, args, { timeoutMs, spawnImpl = spawn, errorPrefix }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      reject(new Error(`${errorPrefix}_failed`));
      return;
    }
    let stdout = '';
    let failure;
    const timer = setTimeout(() => {
      failure = `${errorPrefix}_timeout`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', chunk => {
      if (stdout.length + chunk.length > 1024 * 1024) {
        failure = `${errorPrefix}_invalid_output`;
        child.kill('SIGKILL');
      } else {
        stdout += chunk.toString();
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error(`${errorPrefix}_failed`));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(new Error(failure || `${errorPrefix}_failed`));
      else resolve(stdout);
    });
  });
}

function validTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 && value <= 2147483647 ? value : fallback;
}

async function probeVideo(file, options = {}) {
  const stdout = await runProcess(options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe',
    ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
      'format=duration:stream=codec_type,width,height,duration', '-of', 'json', file], {
      timeoutMs: validTimeout(options.timeoutMs, 30000), spawnImpl: options.spawnImpl, errorPrefix: 'ffprobe',
    });
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('invalid_video');
  }
  if (!Array.isArray(info?.streams)) throw new Error('invalid_video');
  const video = info.streams.find(stream => stream.codec_type === 'video');
  const durationSec = Number(info.format?.duration || video?.duration);
  if (!video || !Number.isFinite(durationSec) || durationSec <= 0 ||
      !Number.isInteger(video.width) || video.width <= 0 ||
      !Number.isInteger(video.height) || video.height <= 0) {
    throw new Error('invalid_video');
  }
  return { durationSec, hasAudio: info.streams.some(stream => stream.codec_type === 'audio'),
    width: video.width, height: video.height };
}

async function renderVideo(opts, options = {}) {
  await runProcess(options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg', buildFfmpegArgs(opts), {
    timeoutMs: validTimeout(options.timeoutMs,
      validTimeout(Number(process.env.REACT_RENDER_TIMEOUT_SEC) * 1000, 900000)),
    spawnImpl: options.spawnImpl,
    errorPrefix: 'ffmpeg',
  });
}

module.exports = { buildFfmpegArgs, probeVideo, renderVideo };
