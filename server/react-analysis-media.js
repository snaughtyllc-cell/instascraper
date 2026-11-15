const { spawn } = require('node:child_process');
const os = require('node:os');
const { resolveFfmpegThreads, resolveFfmpegNice } = require('./react-ffmpeg');

const WIDTH = 90, HEIGHT = 160, FPS = 4, SEAM_THRESHOLD = 12;
const round = number => Math.round(number * 1000000) / 1000000;

function frameSeam(frame, width = WIDTH, height = HEIGHT) {
  if (!frame || frame.length !== width * height) throw new Error('invalid_analysis_frame');
  const rows = Array.from({ length: height }, (_, y) => {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += frame[y * width + x];
    return sum / width;
  });
  let best = { row: Math.round(height / 2), strength: 0 };
  for (let row = Math.ceil(height * 0.25); row <= Math.floor(height * 0.75); row++) {
    // mean(row-2..row) - mean(row..row+2); the shared row cancels.
    const strength = Math.abs(rows[row - 2] + rows[row - 1] - rows[row + 1] - rows[row + 2]) / 3;
    if (strength > 0 && strength >= best.strength) best = { row, strength };
  }
  return best;
}

function mergeLayout(kinds, durationSec, fps = FPS) {
  if (!kinds.length || !(durationSec > 0)) return [];
  const smoothed = [...kinds];
  // Replace isolated quarter-second detections; preserve genuine half-second cuts.
  for (let start = 0; start < smoothed.length;) {
    let end = start + 1;
    while (end < smoothed.length && smoothed[end] === smoothed[start]) end++;
    if ((end - start) / fps < 0.5 && smoothed.length > end - start) {
      const replacement = start ? smoothed[start - 1] : smoothed[end];
      smoothed.fill(replacement, start, end);
    }
    start = end;
  }
  const segments = [];
  for (let start = 0; start < smoothed.length && start / fps < durationSec;) {
    let end = start + 1;
    while (end < smoothed.length && smoothed[end] === smoothed[start]) end++;
    const from = round(start / fps), to = round(Math.min(durationSec, end / fps));
    if (to > from) segments.push({ start: from, end: to, kind: smoothed[start] });
    start = end;
  }
  if (segments.length) segments[segments.length - 1].end = durationSec;
  // The final partial frame may leave a very short segment at the boundary.
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments.length > 1 && segments[i].end - segments[i].start < 0.5) {
      if (i) { segments[i - 1].end = segments[i].end; segments.splice(i, 1); }
      else { segments[1].start = 0; segments.splice(0, 1); }
    }
  }
  return segments;
}

function analyzeFrames(raw, durationSec, { width = WIDTH, height = HEIGHT, fps = FPS, threshold = SEAM_THRESHOLD } = {}) {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !raw?.length || raw.length % (width * height)) {
    throw new Error('invalid_analysis_frames');
  }
  const frames = [];
  for (let offset = 0; offset < raw.length; offset += width * height) frames.push(frameSeam(raw.subarray(offset, offset + width * height), width, height));
  const candidates = frames.filter(frame => frame.strength > threshold).map(frame => frame.row).sort((a, b) => a - b);
  const median = candidates.length ? candidates[Math.floor(candidates.length / 2)] : null;
  const matching = frames.filter(frame => frame.strength > threshold && Math.abs(frame.row - median) <= height * 0.04).length;
  const seam = median !== null && matching >= Math.max(2, Math.ceil(frames.length * 0.1)) ? median / height : null;
  // A weak next sample means the cut may already have happened between samples.
  // Err one sample early so a transition into full-screen cannot be frozen as split.
  return { seam, layout: mergeLayout(frames.map((frame, index) => seam !== null && frame.strength > threshold
    && (frames[index + 1] || frame).strength > threshold
    && Math.abs(frame.row / height - seam) <= 0.04 ? 'split' : 'full'), durationSec, fps) };
}

function parseSilences(stderr, durationSec) {
  const intervals = [];
  let start;
  for (const match of String(stderr).matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g)) {
    const value = Math.max(0, Math.min(durationSec, Number(match[2])));
    if (match[1] === 'start') start = value;
    else if (start !== undefined) { if (value > start) intervals.push({ start, end: value }); start = undefined; }
  }
  if (start !== undefined && durationSec > start) intervals.push({ start, end: durationSec });
  return intervals;
}

function snapCreatorCues(utterances, silences, durationSec) {
  const edges = silences.flatMap(silence => [silence.start, silence.end]).filter(Number.isFinite).sort((a, b) => a - b);
  return utterances.filter(item => item.role === 'creator').slice(0, 200).map(item => {
    const start = Math.max(0, Math.min(durationSec, item.start)), end = Math.max(0, Math.min(durationSec, item.end));
    const before = edges.filter(edge => edge <= start && start - edge <= 0.35).at(-1);
    const after = edges.find(edge => edge >= end && edge - end <= 0.35);
    return { start: Math.min(durationSec, round(before ?? start)), end: Math.min(durationSec, round(after ?? end)), text: item.text.slice(0, 300) };
  }).filter(cue => cue.end > cue.start).sort((a, b) => a.start - b.start || a.end - b.end);
}

function muteEnvelope(cues) {
  const spans = [];
  for (const cue of [...cues].sort((a, b) => a.start - b.start)) {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start) throw new Error('invalid_mute_span');
    const previous = spans.at(-1);
    if (previous && cue.start <= previous.end) previous.end = Math.max(previous.end, cue.end);
    else spans.push({ start: cue.start, end: cue.end });
  }
  // Gain reaches zero exactly at each cue boundary. Fade outside the creator's
  // lines so their first/last phonemes cannot leak through a fade inside a cue.
  return spans.map(span => `clip(max((${round(span.start)}-t)/0.04,(t-${round(span.end)})/0.04),0,1)`).join('*') || '1';
}

function analysisProcess(args, { env = process.env, signal, timeoutMs = 120000,
  maxBytes = 64 * 1024 * 1024, spawnImpl = spawn, setPriorityImpl = os.setPriority } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('analysis_timeout')); return; }
    let child;
    try { child = spawnImpl(env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch { reject(new Error('analysis_ffmpeg_failed')); return; }
    const nice = resolveFfmpegNice(env.REACT_FFMPEG_NICE);
    if (nice > 0 && child.pid) { try { setPriorityImpl(child.pid, nice); } catch { /* Best effort. */ } }
    let failure, bytes = 0, stderr = '';
    const chunks = [];
    const abort = () => { failure = 'analysis_timeout'; child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    child.stdout?.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { failure = 'analysis_output_too_large'; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.stderr?.on('data', chunk => { if (stderr.length < 1024 * 1024) stderr += chunk.toString(); });
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', () => { clean(); reject(new Error('analysis_ffmpeg_failed')); });
    child.once('close', code => {
      clean();
      if (failure || code !== 0) reject(new Error(failure || 'analysis_ffmpeg_failed'));
      else resolve({ stdout: Buffer.concat(chunks), stderr });
    });
  });
}

function inputArgs(filePath, env) {
  return ['-hide_banner', '-nostdin', '-threads', String(resolveFfmpegThreads(env.REACT_FFMPEG_THREADS)),
    '-protocol_whitelist', 'file,pipe', '-i', filePath];
}

async function inspectLayout(filePath, durationSec, options = {}) {
  const env = options.env || process.env;
  const result = await analysisProcess([...inputArgs(filePath, env), '-an', '-vf', 'fps=4,scale=90:160,format=gray',
    '-filter_threads', String(resolveFfmpegThreads(env.REACT_FFMPEG_THREADS)), '-threads', String(resolveFfmpegThreads(env.REACT_FFMPEG_THREADS)),
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], options);
  return analyzeFrames(result.stdout, durationSec);
}

async function detectSilences(filePath, durationSec, options = {}) {
  const env = options.env || process.env;
  const result = await analysisProcess([...inputArgs(filePath, env), '-vn', '-af', 'silencedetect=n=-35dB:d=0.15', '-f', 'null', '-'], options);
  return parseSilences(result.stderr, durationSec);
}

async function muteCreator(filePath, outputPath, cues, hasAudio, durationSec, options = {}) {
  const env = options.env || process.env, threads = String(resolveFfmpegThreads(env.REACT_FFMPEG_THREADS));
  const args = [...inputArgs(filePath, env), '-y'];
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0');
  if (hasAudio) {
    const envelope = muteEnvelope(cues);
    args.push('-af', `aformat=channel_layouts=stereo,aeval='val(0)*${envelope}|val(1)*${envelope}'`);
  }
  args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-threads', threads, '-filter_threads', threads, '-t', String(durationSec), '-movflags', '+faststart', outputPath);
  await analysisProcess(args, options);
}

module.exports = { frameSeam, analyzeFrames, mergeLayout, parseSilences, snapCreatorCues,
  muteEnvelope, analysisProcess, inspectLayout, detectSilences, muteCreator };
