const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { computeFit, routeCandidate } = require('./candidate-routing');
const { sortConfig } = require('./sort-status');
const { runAutoSort, sortUsage } = require('./sort-runner');
const { videoFilePath } = require('./videos');
const { ensureLookTables, ensureWorkspaceTables } = require('./workspace-migration');
const { ensureSortStatus } = require('./sort-migration');

const talking = { ai_type: 'talking', ai_confidence: 0.9, ai_classified_at: '2026-11-15T00:00:00Z', ai_error: null };
const dance = { ...talking, ai_type: 'dance' };

async function setup(t, { source = 'Mia.Talks', count = 3 } = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, shortcode TEXT, account_handle TEXT,
    caption TEXT, posted_at TEXT, video_cache_status TEXT, content_type TEXT, sort_status TEXT DEFAULT 'unsorted',
    archived INTEGER DEFAULT 0, soft_deleted INTEGER DEFAULT 0, ai_attempts INTEGER DEFAULT 0,
    ai_last_attempt_at TEXT, ai_type TEXT, ai_confidence REAL, ai_description TEXT, ai_suggested_type TEXT,
    ai_model TEXT, ai_classified_at TEXT, ai_cost_usd REAL, ai_error TEXT);
    CREATE TABLE suggested_accounts (username TEXT PRIMARY KEY, source TEXT);
    CREATE TABLE suggested_reels (id INTEGER PRIMARY KEY, username TEXT, shortcode TEXT, video_url TEXT,
      rank INTEGER, ai_type TEXT, ai_confidence REAL, ai_error TEXT, ai_classified_at TEXT, ai_cost_usd REAL);
    CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT, primary_niche TEXT, secondary_niches TEXT, status TEXT DEFAULT 'active');
    CREATE TABLE model_creators (model_id INTEGER, username TEXT, PRIMARY KEY(model_id,username));
    CREATE TABLE model_suggestions (model_id INTEGER, username TEXT, fit REAL, reason TEXT,
      status TEXT DEFAULT 'pending', snoozed_until TEXT, reviewed_at TEXT, created_at TEXT,
      PRIMARY KEY(model_id,username));
    CREATE TABLE content_types (value TEXT, label TEXT, description TEXT, sort_order INTEGER DEFAULT 0);
    INSERT INTO models(id,name,primary_niche) VALUES(1,'Logan','talking'),(2,'Gigi','dance');
    INSERT INTO models(id,name,primary_niche,status) VALUES(3,'Inactive','talking','paused');
    INSERT INTO content_types(value,label) VALUES('talking','Talking'),('dance','Dance');
    INSERT INTO model_creators VALUES(1,'mia.talks');`);
  sqlite.prepare('INSERT INTO suggested_accounts VALUES(?,?)').run('candidate', source);
  for (let id = 1; id <= count; id++) {
    sqlite.prepare('INSERT INTO suggested_reels(id,username,shortcode,video_url,rank) VALUES(?,?,?,?,?)')
      .run(id, id === 2 ? 'Candidate' : 'candidate', `reel${id}`, 'https://example.test/fake.mp4', id);
  }
  const pool = { sqlite, query: async (sql, params = []) => {
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
    assert.deepEqual(placeholders, params.map((_, i) => i + 1), 'SQLite placeholder order');
    const stmt = sqlite.prepare(sql.replace(/\$\d+/g, '?'));
    if (stmt.reader) { const rows = stmt.all(...params); return { rows, rowCount: rows.length }; }
    return { rows: [], rowCount: stmt.run(...params).changes };
  } };
  await ensureSortStatus(pool, { isPg: false });
  await ensureWorkspaceTables(pool, { isPg: false });
  await ensureLookTables(pool, { isPg: false });
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-routing-'));
  t.after(async () => { sqlite.close(); await fs.rm(videoDir, { recursive: true, force: true }); });
  return {
    pool, videoDir, cfg: { ...sortConfig({ GEMINI_API_KEY: 'fake' }), enabled: true },
    download: async (reel, { videoDir: destination }) => {
      const filePath = videoFilePath(reel, destination);
      await fs.writeFile(filePath, 'fake video');
      return { status: 'cached', path: filePath };
    },
    describe: async ({ filePath }) => {
      await fs.access(filePath);
      return { type: 'talking', confidence: 0.9, audioKind: 'own_speech', usage: { inTokens: 1000, outTokens: 50 } };
    },
  };
}

test('computeFit counts confident niche matches and caps the source boost', () => {
  const input = { reels: [talking, talking, dance], niches: ['talking'], minConfidence: 0.8, sourceOwned: false, boost: 0.25 };
  assert.equal(computeFit(input), 2 / 3);
  assert.equal(computeFit({ ...input, sourceOwned: true }), 2 / 3 + 0.25);
  assert.equal(computeFit({ ...input, reels: [talking], sourceOwned: true }), null);
  assert.equal(computeFit({ ...input, reels: [talking, { ...talking, ai_confidence: 0.2 }, dance] }), 1 / 3);
  assert.equal(computeFit({ ...input, reels: [talking, talking], sourceOwned: true }), 1);
  assert.equal(computeFit({ ...input, reels: [talking, { ...talking, ai_error: 'failed' }] }), null);
});

test('routes to matching active models only, with case-insensitive sources and usernames', async t => {
  const deps = await setup(t);
  assert.deepEqual(await routeCandidate('CANDIDATE', deps), { sorted: 3, routed: [1] });
  const row = deps.pool.sqlite.prepare('SELECT * FROM model_suggestions').get();
  assert.equal(row.username, 'candidate');
  assert.equal(row.fit, 1);
  assert.equal(row.reason, "3 of 3 reels Talking · found via @mia.talks (Logan's creator)");
  assert.deepEqual(await fs.readdir(deps.videoDir), []);
  assert.equal((await routeCandidate('candidate', deps)).sorted, 0);
});

test("source boost uses only that model's creators and comma-separated tokens", async t => {
  const deps = await setup(t, { source: 'other, MIA.TALKS, elsewhere' });
  deps.pool.sqlite.exec("UPDATE models SET primary_niche='talking' WHERE id=2");
  let n = 0;
  deps.describe = async () => ({ type: ++n === 1 ? 'talking' : 'dance', confidence: 0.9, audioKind: 'own_speech' });
  assert.deepEqual((await routeCandidate('candidate', deps)).routed, [1]);
  const row = deps.pool.sqlite.prepare('SELECT * FROM model_suggestions').get();
  assert.equal(row.fit, 1 / 3 + 0.25);
  assert.equal(row.reason, "1 of 3 reels Talking · found via @mia.talks (Logan's creator)");
});

test('expired candidate reels → no routing, no throw', async t => {
  const deps = await setup(t);
  let calls = 0;
  deps.download = async () => { calls++; return { status: 'expired', error: 'HTTP 403' }; };
  deps.describe = async () => { assert.fail('expired downloads must not reach Gemini'); };
  assert.deepEqual(await routeCandidate('candidate', deps), { sorted: 0, routed: [] });
  assert.equal(calls, 3, '403 is never retried');
  assert.equal(deps.pool.sqlite.prepare('SELECT COUNT(*) AS n FROM model_suggestions').get().n, 0);
  assert.match(deps.pool.sqlite.prepare('SELECT ai_error FROM suggested_reels LIMIT 1').get().ai_error, /403/);
  assert.deepEqual(await fs.readdir(deps.videoDir), []);
});

test('candidate routing uses type definitions and cannot route music as talking', async t => {
  const deps = await setup(t, { source: '' });
  deps.pool.sqlite.exec("INSERT INTO content_types(value,label,description) VALUES('lipsync','Lip sync','Mouths along to music'); UPDATE content_types SET description='Live own speech' WHERE value='talking'; INSERT INTO models(id,name,primary_niche) VALUES(4,'Lip sync model','lipsync')");
  deps.describe = async input => {
    assert.equal(input.types.find(type => type.value === 'talking').description, 'Live own speech');
    return { type: 'talking', confidence: 0.9, audioKind: 'music_or_trending_audio' };
  };
  assert.deepEqual((await routeCandidate('candidate', deps)).routed, [4]);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT ai_type,ai_confidence FROM suggested_reels').all(), Array(3).fill({ ai_type: 'lipsync', ai_confidence: 0.9 }));
});

test('transient download responses get bounded retries and a permanent 403 never does', async t => {
  const deps = await setup(t, { count: 1 });
  let calls = 0;
  deps.download = async () => { calls++; return { status: 'error', error: 'HTTP 503' }; };
  assert.deepEqual(await routeCandidate('candidate', deps), { sorted: 0, routed: [] });
  assert.equal(calls, 3);
});

test('candidate temp files never overwrite or delete a cached post with the same id', async t => {
  const deps = await setup(t);
  const cachedPost = path.join(deps.videoDir, '1.mp4');
  await fs.writeFile(cachedPost, 'existing cached post');
  await routeCandidate('candidate', deps);
  assert.equal(await fs.readFile(cachedPost, 'utf8'), 'existing cached post');
  assert.deepEqual(await fs.readdir(deps.videoDir), ['1.mp4']);
});

test('candidate sorting respects daily cap including post attempts and previous candidates', async t => {
  const deps = await setup(t);
  deps.cfg.dailyMax = 3;
  deps.pool.sqlite.prepare('INSERT INTO posts(ai_attempts,ai_last_attempt_at) VALUES(?,?)').run(1, new Date().toISOString());
  deps.pool.sqlite.prepare('UPDATE suggested_reels SET ai_type=?,ai_confidence=?,ai_classified_at=? WHERE id=1')
    .run('talking', 0.9, new Date().toISOString());
  assert.equal((await routeCandidate('candidate', deps)).sorted, 1);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 3);
  assert.equal((await routeCandidate('candidate', deps)).sorted, 0);
});

test('existing dismissed suggestion keeps status, snooze and review state', async t => {
  const deps = await setup(t);
  deps.pool.sqlite.exec("INSERT INTO model_suggestions(model_id,username,fit,status,snoozed_until,reviewed_at) VALUES(1,'candidate',0.4,'dismissed','later','earlier')");
  await routeCandidate('candidate', deps);
  const row = deps.pool.sqlite.prepare('SELECT * FROM model_suggestions').get();
  assert.equal(row.status, 'dismissed');
  assert.equal(row.snoozed_until, 'later');
  assert.equal(row.reviewed_at, 'earlier');
});

test('Gemini failures and partial downloads are recorded and temp files are removed', async t => {
  const deps = await setup(t);
  const successfulDownload = deps.download;
  let calls = 0;
  deps.download = async (...args) => {
    await successfulDownload(...args);
    if (++calls === 1) throw new Error('download interrupted');
    return { status: 'cached' };
  };
  deps.describe = async () => { throw new Error('Gemini unavailable'); };
  assert.deepEqual(await routeCandidate('candidate', deps), { sorted: 0, routed: [] });
  assert.deepEqual(await fs.readdir(deps.videoDir), []);
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT ai_error FROM suggested_reels ORDER BY rank').all(), [
    { ai_error: 'download interrupted' }, { ai_error: 'Gemini unavailable' }, { ai_error: 'Gemini unavailable' },
  ]);
});

test('disabled candidate routing makes no downloads or database calls', async t => {
  const deps = await setup(t);
  deps.cfg.enabled = false;
  deps.pool = { query: async () => assert.fail('disabled routing queried the database') };
  deps.download = async () => assert.fail('disabled routing downloaded a video');
  assert.deepEqual(await routeCandidate('candidate', deps), { sorted: 0, routed: [] });
});

test('candidate sorting and post sorting share the daily cap during concurrent runs', async t => {
  const deps = await setup(t);
  deps.cfg.dailyMax = 1;
  deps.pool.sqlite.exec("INSERT INTO posts(id,shortcode,posted_at,video_cache_status) VALUES(100,'post','2026-11-15','cached')");
  await fs.writeFile(path.join(deps.videoDir, '100.mp4'), 'fake video');
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  deps.describe = async () => { start(); await new Promise(resolve => { release = resolve; }); return { type: 'talking', confidence: 0.9 }; };
  const routing = routeCandidate('candidate', deps);
  await started;
  const sorting = runAutoSort({ ...deps, waitForIdle: true });
  release();
  assert.equal((await routing).sorted, 1);
  assert.equal((await sorting).classified, 0);
  assert.equal((await sortUsage(deps.pool, deps.cfg)).today, 1);
});
test('candidate reel stores ai_look_tags', async t => {
  const deps = await setup(t, { count: 1 });
  deps.pool.sqlite.exec(`CREATE TABLE IF NOT EXISTS look_tags(value TEXT, label TEXT, category TEXT, sort_order INTEGER);
    INSERT INTO look_tags(value,label,category) VALUES('brunette','Brunette','hair'),('private-custom','Private custom','custom')`);
  deps.describe = async input => {
    assert.deepEqual(input.lookTags.map(tag => tag.value), ['brunette']);
    return { type: 'talking', confidence: 0.9, lookTags: ['brunette'] };
  };
  await routeCandidate('candidate', deps);
  assert.equal(deps.pool.sqlite.prepare('SELECT ai_look_tags FROM suggested_reels').get().ai_look_tags, '["brunette"]');
});

test('candidate descriptions persist sanitized layout without changing suggestion scoring', async t => {
  const deps = await setup(t);
  const layouts = ['split_screen', 'gameplay_overlay', 'invalid'];
  const describe = deps.describe;
  deps.describe = async input => ({ ...await describe(input), layout: layouts.shift() });
  assert.deepEqual(await routeCandidate('candidate', deps), { sorted: 3, routed: [1] });
  assert.deepEqual(deps.pool.sqlite.prepare('SELECT ai_layout FROM suggested_reels ORDER BY id').all(), [
    { ai_layout: 'split_screen' }, { ai_layout: 'gameplay_overlay' }, { ai_layout: null },
  ]);
});
