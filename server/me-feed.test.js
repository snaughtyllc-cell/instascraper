// server/me-feed.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildMeFeedQuery, nicheVisibilityClause, parseNiches } = require('./me-feed');

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
