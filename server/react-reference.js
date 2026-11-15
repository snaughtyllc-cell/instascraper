const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const videos = require('./videos');

function isValidShortcode(shortcode) {
  return typeof shortcode === 'string' && /^[A-Za-z0-9_-]{5,64}$/.test(shortcode);
}

function usableFile(file, fileSystem = fs) {
  try {
    const stat = fileSystem.lstatSync(file);
    return stat.isFile() && stat.size > 0;
  } catch { return false; }
}

function referenceFile(shortcode, env = process.env) {
  if (!isValidShortcode(shortcode)) return null;
  const dir = env.REACT_REF_DIR || path.join(path.dirname(videos.DEFAULT_VIDEO_DIR), 'react-refs');
  return path.resolve(dir, `${shortcode}.mp4`);
}

function getPinnedReferencePath(shortcode) {
  const file = referenceFile(shortcode);
  return file && usableFile(file) ? file : null;
}

function availableReferencePath(post) {
  if (!post) return null;
  // Existing signed feed media uses the numeric post ID, even for legacy rows
  // whose shortcode cannot be used as a new React reference filename.
  if (post.id == null && !isValidShortcode(post.shortcode)) return null;
  const cache = videos.videoFilePath(post, videos.DEFAULT_VIDEO_DIR);
  return usableFile(cache) ? cache : getPinnedReferencePath(post.shortcode);
}

function probeDuration(file) {
  return new Promise(resolve => {
    execFile(process.env.FFPROBE_PATH || 'ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration', '-of', 'json', file,
    ], { timeout: 30000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const value = Number(JSON.parse(stdout).format?.duration);
        resolve(Number.isFinite(value) && value > 0 ? value : null);
      } catch { resolve(null); }
    });
  });
}

async function ensureReactReference(pool, shortcode, deps = {}) {
  if (!isValidShortcode(shortcode)) return null;
  const result = await pool.query('SELECT * FROM posts WHERE shortcode = $1 LIMIT 1', [shortcode]);
  const post = result.rows[0];
  if (!post) return null;
  const fileSystem = deps.fs || fs;
  const pin = referenceFile(shortcode);
  const probe = deps.probeDuration || probeDuration;
  if (usableFile(pin, fileSystem)) return { post, path: pin, durationSec: await probe(pin) };
  const cache = videos.videoFilePath(post, videos.DEFAULT_VIDEO_DIR);
  if (!usableFile(cache, fileSystem)) {
    const download = deps.downloadVideo || videos.downloadVideo;
    const delay = deps.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < 3; attempt++) {
      let outcome;
      try { outcome = await download(post); } catch { return null; }
      if (usableFile(cache, fileSystem)) break;
      if (!/^HTTP (429|5\d\d)$/.test(outcome?.error || '') || attempt === 2) return null;
      await delay(250 * 2 ** attempt);
    }
  }
  if (!usableFile(cache, fileSystem)) return null;
  // Publish the pin atomically: neither a concurrent render nor /media should
  // observe a partially copied file when the cache and pins span filesystems.
  const temporary = `${pin}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fileSystem.mkdirSync(path.dirname(pin), { recursive: true });
    try { fileSystem.linkSync(cache, temporary); }
    catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(error.code)) throw error;
      fileSystem.copyFileSync(cache, temporary, fs.constants.COPYFILE_EXCL);
    }
    if (!usableFile(temporary, fileSystem)) return null;
    fileSystem.renameSync(temporary, pin);
  } catch { return null; }
  finally {
    try { fileSystem.unlinkSync(temporary); } catch { /* Already published or absent. */ }
  }
  return { post, path: pin, durationSec: await probe(pin) };
}

module.exports = { isValidShortcode, getPinnedReferencePath, availableReferencePath, ensureReactReference };
