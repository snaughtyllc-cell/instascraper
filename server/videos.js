const path = require('path');
const crypto = require('crypto');
const realFs = require('fs');
const realFetch = require('node-fetch');
const { DEFAULT_THUMB_DIR } = require('./thumbnails');

const DEFAULT_VIDEO_DIR = path.join(DEFAULT_THUMB_DIR, 'videos');
const VIDEO_MAX_MB = Number(process.env.VIDEO_MAX_MB || 60);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const sharedInflight = new Map();

function videoFilePath(post, videoDir = DEFAULT_VIDEO_DIR) {
  const key = post.id != null ? post.id : post.shortcode;
  return path.join(videoDir, `${key}.mp4`);
}

function tempVideoPath(key, videoDir = DEFAULT_VIDEO_DIR) {
  // [R2-7] crypto suffix: concurrent same-id/different-url writers must not collide.
  return path.join(videoDir, `${key}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
}

module.exports = { DEFAULT_VIDEO_DIR, VIDEO_MAX_MB, videoFilePath, tempVideoPath };
