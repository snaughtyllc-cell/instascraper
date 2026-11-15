const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.NODE_USE_SYSTEM_CA = '0';
const videos = require('./videos');
const { isValidShortcode, ensureReactReference, getPinnedReferencePath, availableReferencePath } = require('./react-reference');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-reference-'));
const videoDir = videos.DEFAULT_VIDEO_DIR;
const referenceDir = process.env.REACT_REF_DIR;
const post = { id: 42, shortcode: 'react_42', video_url: 'https://cdn.example/video.mp4' };
const pool = { query: async (sql, params) => {
  assert.match(sql, /WHERE shortcode = \$1/);
  assert.deepEqual(params, [post.shortcode]);
  return { rows: [post] };
} };
const cache = path.join(dir, 'videos', '42.mp4');
const pin = path.join(dir, 'pins', 'react_42.mp4');
const probeDuration = async file => { assert.equal(file, pin); return 3.25; };

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'videos'), { recursive: true });
  process.env.REACT_REF_DIR = path.join(dir, 'pins');
  videos.DEFAULT_VIDEO_DIR = path.join(dir, 'videos');
});
after(() => {
  videos.DEFAULT_VIDEO_DIR = videoDir;
  if (referenceDir === undefined) delete process.env.REACT_REF_DIR;
  else process.env.REACT_REF_DIR = referenceDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reference shortcode validation enforces exact alphabet and bounds', async () => {
  for (const value of [undefined, null, {}, '', 'abcd', 'x'.repeat(65), '../escape', 'valid\n']) {
    assert.equal(isValidShortcode(value), false);
    assert.equal(getPinnedReferencePath(value), null);
    assert.equal(await ensureReactReference({ query: () => assert.fail('invalid shortcode must not query') }, value), null);
  }
  for (const value of ['abc12', 'A_-b9', 'x'.repeat(64)]) assert.equal(isValidShortcode(value), true);
});

test('cached reference is hard-linked into independent retention storage', async () => {
  fs.writeFileSync(cache, 'cached mp4');
  const result = await ensureReactReference(pool, post.shortcode, {
    probeDuration, downloadVideo: () => assert.fail('already cached'),
  });
  assert.deepEqual(result, { post, path: pin, durationSec: 3.25 });
  assert.equal(fs.statSync(cache).ino, fs.statSync(pin).ino);
  assert.equal(availableReferencePath(post), cache, 'cache precedes pin');
  fs.unlinkSync(cache);
  assert.equal(getPinnedReferencePath(post.shortcode), pin);
  assert.equal(availableReferencePath(post), pin);
  assert.equal(fs.readFileSync(pin, 'utf8'), 'cached mp4', 'pruning cache cannot remove pin');
  assert.deepEqual(await ensureReactReference(pool, post.shortcode, {
    probeDuration, downloadVideo: () => assert.fail('pin survives expired source URL'),
  }), result);
});

test('missing reference downloads, then pins the actual cache file', async () => {
  let downloads = 0;
  const result = await ensureReactReference(pool, post.shortcode, {
    probeDuration,
    downloadVideo: async selected => {
      assert.deepEqual(selected, post);
      downloads++;
      fs.writeFileSync(cache, 'downloaded mp4');
      return { status: 'cached', path: cache };
    },
  });
  assert.equal(downloads, 1);
  assert.equal(result.path, pin);
  assert.equal(fs.readFileSync(pin, 'utf8'), 'downloaded mp4');
});

test('cross-filesystem pin falls back to an atomic copy', async () => {
  fs.writeFileSync(cache, 'copied mp4');
  const fileSystem = {
    ...fs,
    linkSync: () => { throw Object.assign(new Error('different filesystem'), { code: 'EXDEV' }); },
  };
  const result = await ensureReactReference(pool, post.shortcode, { fs: fileSystem, probeDuration });
  assert.equal(result.path, pin);
  assert.equal(fs.readFileSync(pin, 'utf8'), 'copied mp4');
  assert.notEqual(fs.statSync(cache).ino, fs.statSync(pin).ino);
  assert.deepEqual(fs.readdirSync(path.dirname(pin)), ['react_42.mp4']);
});

test('absent, failed, empty and non-file references are unavailable', async () => {
  assert.equal(await ensureReactReference({ query: async () => ({ rows: [] }) }, 'missing'), null);
  for (const error of ['HTTP 403', 'HTTP 404', 'network failure containing https://secret.example']) {
    let attempts = 0;
    assert.equal(await ensureReactReference(pool, post.shortcode, {
      downloadVideo: async () => { attempts++; return { status: 'error', error }; },
    }), null);
    assert.equal(attempts, 1);
  }
  fs.writeFileSync(cache, '');
  assert.equal(availableReferencePath(post), null);
  assert.equal(await ensureReactReference(pool, post.shortcode, { downloadVideo: async () => ({ status: 'cached' }) }), null);
  fs.unlinkSync(cache);
  fs.mkdirSync(cache);
  assert.equal(availableReferencePath(post), null);
  assert.equal(await ensureReactReference(pool, post.shortcode, { downloadVideo: async () => ({ status: 'cached' }) }), null);
});

test('reference downloads retry rate limits and server failures with bounded backoff', async () => {
  const delays = [];
  let attempts = 0;
  const result = await ensureReactReference(pool, post.shortcode, {
    probeDuration, delay: async ms => delays.push(ms),
    downloadVideo: async () => {
      attempts++;
      if (attempts < 3) return { status: 'error', error: attempts === 1 ? 'HTTP 429' : 'HTTP 503' };
      fs.writeFileSync(cache, 'retried mp4');
      return { status: 'cached' };
    },
  });
  assert.equal(result.path, pin);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 500]);
});

test('failed pin copy cleans partial temporary files and reports unavailable', async () => {
  fs.writeFileSync(cache, 'cached mp4');
  const fileSystem = {
    ...fs,
    linkSync: () => { throw Object.assign(new Error('different filesystem'), { code: 'EXDEV' }); },
    copyFileSync: (_source, target) => { fs.writeFileSync(target, 'partial'); throw new Error('disk full'); },
  };
  assert.equal(await ensureReactReference(pool, post.shortcode, { fs: fileSystem }), null);
  assert.deepEqual(fs.readdirSync(path.dirname(pin)), []);
});

test('legacy cached media does not require a React-compatible shortcode', () => {
  fs.writeFileSync(cache, 'legacy cached media');
  assert.equal(availableReferencePath({ id: 42, shortcode: null }), cache);
  assert.equal(availableReferencePath({ shortcode: '../outside' }), null);
});

test('ready fetched references resolve without posts or a fresh download', async () => {
  fs.mkdirSync(path.dirname(pin), { recursive: true });
  fs.writeFileSync(pin, 'fetched mp4');
  const queries = [];
  const fetchedPool = { query: async (sql, params) => {
    queries.push(sql);
    assert.deepEqual(params, [post.shortcode]);
    return { rows: sql.includes('FROM posts') ? [] : [{ duration_sec: 4.5 }] };
  } };
  const reference = await ensureReactReference(fetchedPool, post.shortcode, {
    downloadVideo: () => assert.fail('fetched references do not download posts'),
    probeDuration: () => assert.fail('use the stored duration'),
  });
  assert.deepEqual(reference, { post: null, path: pin, durationSec: 4.5, fetched: true });
  assert.equal(queries.length, 2);
  assert.match(queries[1], /state = 'ready'/);
  fs.unlinkSync(pin);
  assert.equal(await ensureReactReference(fetchedPool, post.shortcode), null, 'missing ready files fail closed');
  fs.symlinkSync(cache, pin);
  fs.writeFileSync(cache, 'outside reference');
  assert.equal(await ensureReactReference(fetchedPool, post.shortcode), null, 'symlinks fail closed');
});

test('a post without usable video can fall back to a ready fetched reference', async () => {
  fs.mkdirSync(path.dirname(pin), { recursive: true });
  fs.writeFileSync(pin, 'fetched mp4');
  const fetchedPool = { query: async sql => ({ rows: sql.includes('FROM posts')
    ? [{ ...post, video_url: null }] : [{ duration_sec: 4.5 }] }) };
  assert.deepEqual(await ensureReactReference(fetchedPool, post.shortcode, {
    downloadVideo: () => assert.fail('a ready fetched reference needs no post download'),
    probeDuration: () => assert.fail('use the fetched duration'),
  }), { post: null, path: pin, durationSec: 4.5, fetched: true });
});

test('unready fetched rows and orphan pins cannot resolve an unknown shortcode', async () => {
  fs.mkdirSync(path.dirname(pin), { recursive: true });
  fs.writeFileSync(pin, 'orphan pin');
  const absentPool = { query: async () => ({ rows: [] }) };
  assert.equal(await ensureReactReference(absentPool, post.shortcode), null);
});
