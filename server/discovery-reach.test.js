const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { selectDiscoverySources, discoveryConfig } = require('./scheduler');

test('discoveryConfig: defaults + env override, non-numeric falls back', () => {
  const d = discoveryConfig({});
  assert.strictEqual(d.maxSources, 5);
  assert.strictEqual(d.enrichMax, 8);
  const e = discoveryConfig({ DISCOVERY_MAX_SOURCES: '12', DISCOVERY_ENRICH_MAX: 'nope' });
  assert.strictEqual(e.maxSources, 12);
  assert.strictEqual(e.enrichMax, 8); // bad value → default
});

test('selectDiscoverySources: never-discovered first, then oldest-first, capped', () => {
  const accounts = [
    { username: 'beth', last_discovery_at: '2026-06-20T00:00:00Z' },
    { username: 'anna', last_discovery_at: null },              // never → top
    { username: 'carl', last_discovery_at: '2026-06-01T00:00:00Z' }, // oldest dated
    { username: 'dawn', last_discovery_at: '2026-06-28T00:00:00Z' }, // newest dated → last
  ];
  const picked = selectDiscoverySources(accounts, 3).map(a => a.username);
  assert.deepStrictEqual(picked, ['anna', 'carl', 'beth']); // dawn dropped by cap
});

test('selectDiscoverySources: deterministic tie-break by username; empty input', () => {
  const accounts = [
    { username: 'zoe', last_discovery_at: null },
    { username: 'amy', last_discovery_at: null },
  ];
  assert.deepStrictEqual(selectDiscoverySources(accounts, 5).map(a => a.username), ['amy', 'zoe']);
  assert.deepStrictEqual(selectDiscoverySources([], 5), []);
  assert.deepStrictEqual(selectDiscoverySources(undefined, 5), []);
});

test('selectDiscoverySources: malformed date sorts as never-discovered (fail-open)', () => {
  const accounts = [
    { username: 'good', last_discovery_at: '2026-06-10T00:00:00Z' },
    { username: 'bad', last_discovery_at: 'not-a-date' },
  ];
  // malformed → -Infinity → highest priority
  assert.deepStrictEqual(selectDiscoverySources(accounts, 2).map(a => a.username), ['bad', 'good']);
});

// Mirrors the cross-cycle accumulation UPDATE in runDiscovery, with $n → ? for sqlite.
// Validates: monotonic score (never demote), source-token merge (no dupes), pending-only guard.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE suggested_accounts (
    username TEXT UNIQUE, source TEXT, suggestion_score REAL DEFAULT 0,
    relevance_reason TEXT DEFAULT '', status TEXT DEFAULT 'pending'
  )`);
  return db;
}
const ACC_SQL = `UPDATE suggested_accounts
   SET suggestion_score = CASE WHEN ? > suggestion_score THEN ? ELSE suggestion_score END,
       source = CASE WHEN (',' || source || ',') LIKE ('%,' || ? || ',%') THEN source ELSE source || ',' || ? END,
       relevance_reason = ?
 WHERE username = ? AND status = 'pending'`;
// param order matches ascending $1..$6: [score, score, token, token, reason, username]
const acc = (db, { score, token, reason, username }) =>
  db.prepare(ACC_SQL).run(score, score, token, token, reason, username);

test('accumulation: bumps score upward, never demotes', () => {
  const db = makeDb();
  db.prepare("INSERT INTO suggested_accounts (username, source, suggestion_score) VALUES ('x','creatorA',40)").run();
  acc(db, { score: 70, token: 'creatorB', reason: 'r1', username: 'x' });
  assert.strictEqual(db.prepare("SELECT suggestion_score s FROM suggested_accounts WHERE username='x'").get().s, 70);
  acc(db, { score: 10, token: 'creatorC', reason: 'r2', username: 'x' }); // lower → ignored
  assert.strictEqual(db.prepare("SELECT suggestion_score s FROM suggested_accounts WHERE username='x'").get().s, 70);
});

test('accumulation: merges new source token once, no duplicates', () => {
  const db = makeDb();
  db.prepare("INSERT INTO suggested_accounts (username, source, suggestion_score) VALUES ('x','creatorA',40)").run();
  acc(db, { score: 50, token: 'creatorB', reason: 'r', username: 'x' });
  assert.strictEqual(db.prepare("SELECT source FROM suggested_accounts WHERE username='x'").get().source, 'creatorA,creatorB');
  acc(db, { score: 50, token: 'creatorB', reason: 'r', username: 'x' }); // already present → no dupe
  assert.strictEqual(db.prepare("SELECT source FROM suggested_accounts WHERE username='x'").get().source, 'creatorA,creatorB');
});

test('accumulation: does not touch reviewed (non-pending) suggestions', () => {
  const db = makeDb();
  db.prepare("INSERT INTO suggested_accounts (username, source, suggestion_score, status) VALUES ('x','creatorA',40,'dismissed')").run();
  const info = acc(db, { score: 99, token: 'creatorB', reason: 'r', username: 'x' });
  assert.strictEqual(info.changes, 0);
  const row = db.prepare("SELECT suggestion_score s, source FROM suggested_accounts WHERE username='x'").get();
  assert.strictEqual(row.s, 40);
  assert.strictEqual(row.source, 'creatorA');
});
