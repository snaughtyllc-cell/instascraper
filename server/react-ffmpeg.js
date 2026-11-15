const { spawn } = require('node:child_process');
const os = require('node:os');

function resolveFfmpegThreads(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && value.trim() === '')) return 2;
  const threads = Number(value);
  return Number.isInteger(threads) && threads > 0 ? Math.min(threads, 16) : 2;
}

function resolveFreezeMargin(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && value.trim() === '')) return 0.35;
  const margin = Number(value);
  return Number.isFinite(margin) ? Math.max(0, Math.min(1, margin)) : 0.35;
}

function splitSelection(analysis, margin) {
  if (!Array.isArray(analysis?.layout) || !analysis.layout.length) return null;
  let end = 0;
  for (const segment of analysis.layout) {
    if (!segment || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
        segment.start < end || segment.end <= segment.start ||
        !['split', 'full'].includes(segment.kind)) return null;
    end = segment.end;
  }
  const splits = analysis.layout.filter(segment => segment.kind === 'split');
  if (!splits.length || !analysis.layout.some(segment => segment.kind === 'full')) return null;
  return analysis.layout.flatMap((segment, index, layout) => {
    if (segment.kind !== 'split') return [];
    let start = segment.start, end = segment.end;
    if (layout[index - 1]?.kind === 'full') start += 0.15;
    if (layout[index + 1]?.kind === 'full') end -= margin;
    if (end - start < 0.2) {
      const midpoint = (segment.start + segment.end) / 2;
      start = midpoint - 0.1;
      end = midpoint + 0.1;
    }
    // Keep decimal seconds stable for ffmpeg's expression parser.
    return [`gte(t,${Number(start.toFixed(6))})*lt(t,${Number(end.toFixed(6))})`];
  }).join('+');
}

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
  const threads = String(resolveFfmpegThreads(opts.threads));
  const selection = splitSelection(opts.analysis, resolveFreezeMargin(opts.freezeMarginSec));

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-protocol_whitelist', 'file,pipe', '-i', rawPath];
  const graph = [];
  if (output === 'solo') {
    graph.push('[0:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,' +
      'crop=1080:1920,setsar=1,fps=30[v]');
  } else {
    if (syncMs > 0) args.push('-itsoffset', String(syncMs / 1000));
    // Freeze on the original reference timeline before seeking. An input seek
    // could discard the split frame needed by a full segment at the seek point.
    if (syncMs < 0 && !selection) args.push('-ss', String(-syncMs / 1000));
    args.push('-protocol_whitelist', 'file,pipe', '-i', referencePath);
    graph.push('[0:v]setpts=PTS-STARTPTS,scale=1080:960:force_original_aspect_ratio=increase,' +
      'crop=1080:960,setsar=1,fps=30[bot]');
    // Normalize the reference before adding cloned frames: keeping the input
    // offset here as well would apply positive sync twice (also true for audio).
    const startPad = syncMs > 0 ? `,tpad=start_mode=clone:start_duration=${syncMs / 1000}` : '';
    // Exclude uncertain boundary frames, retaining original timestamps; fps
    // fills each omitted full segment with
    // the last split frame and start_time fills a leading full with the first
    // later split frame. The final tpad also covers trailing full segments.
    const freeze = selection ? `,select='${selection}',fps=30:start_time=0` : ',fps=30';
    const seek = selection && syncMs < 0 ? `,trim=start=${-syncMs / 1000},setpts=PTS-STARTPTS` : '';
    graph.push(`[1:v]setpts=PTS-STARTPTS,crop=iw:ih*${crop.height}:0:ih*${crop.top},` +
      'scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1' + freeze +
      `,tpad=stop_mode=clone:stop_duration=600${seek}` +
      `${startPad}[top]`);
    graph.push('[top][bot]vstack=inputs=2[v]');
  }

  if (rawHasAudio) {
    graph.push('[0:a]asetpts=PTS-STARTPTS,highpass=f=80,dynaudnorm=f=150:g=11:p=0.9:m=20,' +
      'loudnorm=I=-16:TP=-1.5:LRA=11:linear=true,aresample=48000,aformat=channel_layouts=stereo,asetpts=N/SR/TB,' +
      `apad,atrim=duration=${rawDuration}[mic]`);
  }
  const useReferenceAudio = output === 'stitched' && referenceAudio && referenceHasAudio;
  if (useReferenceAudio) {
    const delay = syncMs > 0 ? `,adelay=${syncMs}:all=1` : '';
    const seek = selection && syncMs < 0 ? `,atrim=start=${-syncMs / 1000},asetpts=PTS-STARTPTS` : '';
    graph.push(`[1:a]asetpts=PTS-STARTPTS${seek},loudnorm=I=-22:TP=-2,` +
      `aresample=48000,aformat=channel_layouts=stereo${delay},asetpts=N/SR/TB,apad,` +
      `atrim=duration=${rawDuration}[refaudio]`);
  }
  if (rawHasAudio && useReferenceAudio) {
    graph.push('[mic]asplit=2[micmix][sidechain]');
    graph.push('[refaudio][sidechain]sidechaincompress=threshold=0.03:ratio=6:attack=5:release=350[ducked]');
    graph.push('[micmix][ducked]amix=inputs=2:duration=first:normalize=0,' +
      'alimiter=limit=0.89:level=0:latency=1[a]');
  } else if (rawHasAudio || useReferenceAudio) {
    graph.push(`[${rawHasAudio ? 'mic' : 'refaudio'}]alimiter=limit=0.89:level=0:latency=1[a]`);
  } else {
    graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${rawDuration}[a]`);
  }

  args.push('-filter_threads', threads, '-filter_complex_threads', threads,
    '-filter_complex', graph.join(';'), '-map', '[v]', '-map', '[a]',
    '-t', String(rawDuration), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast',
    '-threads', threads, '-x264-params', `threads=${threads}`,
    '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', outputPath);
  return args;
}

function resolveFfmpegNice(value) {
  const nice = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ? Number(value) : NaN;
  return Number.isInteger(nice) && nice >= 0 && nice <= 19 ? nice : 10;
}

function runProcess(command, args, { timeoutMs, spawnImpl = spawn, errorPrefix, nice,
  setPriorityImpl = os.setPriority }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      reject(new Error(`${errorPrefix}_failed`));
      return;
    }
    if (nice > 0 && Number.isInteger(child.pid) && child.pid > 0) {
      try { setPriorityImpl(child.pid, nice); }
      catch { /* Priority is best effort, including denied or already exited children. */ }
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
  const env = options.env || process.env;
  const stdout = await runProcess(options.ffprobePath || env.FFPROBE_PATH || 'ffprobe',
    ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
      'format=duration:stream=codec_type,width,height,duration', '-of', 'json', file], {
      timeoutMs: validTimeout(options.timeoutMs, 30000), spawnImpl: options.spawnImpl, errorPrefix: 'ffprobe',
      nice: resolveFfmpegNice(options.nice ?? env.REACT_FFMPEG_NICE), setPriorityImpl: options.setPriorityImpl,
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
  const env = options.env || process.env;
  const threads = resolveFfmpegThreads(options.threads ?? env.REACT_FFMPEG_THREADS);
  const freezeMarginSec = resolveFreezeMargin(options.freezeMarginSec ?? env.REACT_FREEZE_MARGIN_SEC);
  await runProcess(options.ffmpegPath || env.FFMPEG_PATH || 'ffmpeg', buildFfmpegArgs({ ...opts, threads, freezeMarginSec }), {
    timeoutMs: validTimeout(options.timeoutMs,
      validTimeout(Number(env.REACT_RENDER_TIMEOUT_SEC) * 1000, 900000)),
    spawnImpl: options.spawnImpl,
    nice: resolveFfmpegNice(options.nice ?? env.REACT_FFMPEG_NICE),
    setPriorityImpl: options.setPriorityImpl,
    errorPrefix: 'ffmpeg',
  });
}

module.exports = { buildFfmpegArgs, probeVideo, renderVideo, resolveFfmpegThreads, resolveFfmpegNice, resolveFreezeMargin };
