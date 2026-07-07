const { test } = require('node:test');
const assert = require('node:assert');
const { videoFilePath, tempVideoPath, VIDEO_MAX_MB } = require('./videos');

test('videoFilePath uses id and .mp4 under the given dir', () => {
  assert.strictEqual(videoFilePath({ id: 42 }, '/data/videos'), '/data/videos/42.mp4');
});
test('videoFilePath falls back to shortcode when no id', () => {
  assert.strictEqual(videoFilePath({ shortcode: 'ABC' }, '/data/videos'), '/data/videos/ABC.mp4');
});
test('tempVideoPath is unique-ish and lives under the dir', () => {
  const a = tempVideoPath(42, '/data/videos');
  assert.ok(a.startsWith('/data/videos/42.'));
  assert.ok(a.endsWith('.tmp'));
});
test('VIDEO_MAX_MB defaults to 60', () => {
  assert.strictEqual(VIDEO_MAX_MB, 60);
});
