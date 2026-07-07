// server/me-feed.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildMeFeedQuery, nicheVisibilityClause, parseNiches, visibilityOnlyClause } = require('./me-feed');

test('empty niches → sql null (nothing to show)', () => {
  assert.deepStrictEqual(buildMeFeedQuery([], {}), { sql: null, params: [] });
});
test('nicheVisibilityClause uses IN() placeholders (not ANY) + archived + soft_deleted', () => {
  const { clause, params } = nicheVisibilityClause(['talking', 'dance'], 5);
  assert.match(clause, /COALESCE\(posts\.content_type, ct\.content_type\) IN \(\$5, \$6\)/);
  assert.match(clause, /archived/);
  assert.match(clause, /soft_deleted/);
  assert.doesNotMatch(clause, /ANY/);
  assert.deepStrictEqual(params, ['talking', 'dance']);
});
test('buildMeFeedQuery actually EXECUTES against sqlite and scopes by niche + archived', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, content_type TEXT, account_handle TEXT, posted_at TEXT, soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)`);
  sqlite.exec(`CREATE TABLE creator_types (account_handle TEXT, content_type TEXT)`);
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, archived) VALUES (1,'talking','2026-07-01',0),(2,'dance','2026-07-02',0),(3,'skit','2026-07-03',0),(4,'talking','2026-07-04',1)`).run();
  const { sql, params } = buildMeFeedQuery(['talking', 'dance'], { page: 1, limit: 24 });
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  const ids = rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids, [1, 2], 'only non-archived talking/dance posts; skit + archived excluded');
});
test('parseNiches builds a flat list from primary + comma-separated secondary niches', () => {
  assert.deepStrictEqual(
    parseNiches({ primary_niche: 'talking', secondary_niches: 'dance, skit' }),
    ['talking', 'dance', 'skit']
  );
  assert.deepStrictEqual(
    parseNiches({ primary_niche: 'talking' }),
    ['talking']
  );
});

test('visibilityOnlyClause returns archived + soft_deleted filter with no params, no niche IN', () => {
  const clause = visibilityOnlyClause();
  assert.match(clause, /archived/);
  assert.match(clause, /soft_deleted/);
  assert.doesNotMatch(clause, / IN \(/);
  assert.doesNotMatch(clause, /ANY/);
});

test('buildMeFeedQuery single-niche call still scoped (dance only)', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, content_type TEXT, account_handle TEXT, posted_at TEXT, soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)`);
  sqlite.exec(`CREATE TABLE creator_types (account_handle TEXT, content_type TEXT)`);
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, archived) VALUES (1,'talking','2026-07-01',0),(2,'dance','2026-07-02',0),(3,'skit','2026-07-03',0)`).run();
  const { sql, params } = buildMeFeedQuery(['dance'], {});
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  const ids = rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids, [2], 'only dance post returned');
});

test('buildMeFeedQuery all:true builds a query with NO niche IN() clause but WITH archived/soft_deleted, and executes against sqlite returning ALL visible posts across niches', () => {
  const { sql, params } = buildMeFeedQuery([], { page: 1, limit: 24, all: true });
  assert.ok(sql, 'sql should not be null in all mode');
  assert.doesNotMatch(sql, /IN \(/);
  assert.match(sql, /soft_deleted/);
  assert.match(sql, /archived/);
  assert.deepStrictEqual(params, [24, 0]);

  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, content_type TEXT, account_handle TEXT, posted_at TEXT, soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)`);
  sqlite.exec(`CREATE TABLE creator_types (account_handle TEXT, content_type TEXT)`);
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at, archived, soft_deleted) VALUES (1,'talking','2026-07-01',0,0),(2,'dance','2026-07-02',0,0),(3,'skit','2026-07-03',0,0),(4,'talking','2026-07-04',1,0),(5,'dance','2026-07-05',0,1)`).run();
  const rows = sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  const ids = rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids, [1, 2, 3], 'skit is included in all-mode; archived post 4 and soft-deleted post 5 excluded');
  // newest first ordering check
  assert.deepStrictEqual(rows.map(r => r.id), [3, 2, 1]);
});

test('buildMeFeedQuery all:true placeholder numbering is $1/$2 (params length 0) and does not throw', () => {
  const { sql, params } = buildMeFeedQuery([], { page: 2, limit: 10, all: true });
  assert.match(sql, /LIMIT \$1 OFFSET \$2/);
  assert.deepStrictEqual(params, [10, 10]);
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE posts (id INTEGER PRIMARY KEY, content_type TEXT, account_handle TEXT, posted_at TEXT, soft_deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)`);
  sqlite.exec(`CREATE TABLE creator_types (account_handle TEXT, content_type TEXT)`);
  sqlite.prepare(`INSERT INTO posts (id, content_type, posted_at) VALUES (1,'talking','2026-07-01')`).run();
  assert.doesNotThrow(() => sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params));
});
