const { test } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { normalizeTaggedUsers } = require('./scraper');

test('normalizeTaggedUsers: array of strings', () => {
  assert.deepStrictEqual(normalizeTaggedUsers({ taggedUsers: ['Alice', '@Bob'] }), ['alice', 'bob']);
});

test('normalizeTaggedUsers: array of {username} objects', () => {
  assert.deepStrictEqual(
    normalizeTaggedUsers({ taggedUsers: [{ username: 'Cara' }, { username: 'dee' }] }),
    ['cara', 'dee']
  );
});

test('normalizeTaggedUsers: nested {user:{username}} (usertags shape)', () => {
  assert.deepStrictEqual(
    normalizeTaggedUsers({ usertags: [{ user: { username: 'Eve' } }] }),
    ['eve']
  );
});

test('normalizeTaggedUsers: de-dupes and drops owner', () => {
  assert.deepStrictEqual(
    normalizeTaggedUsers({ taggedUsers: ['x', 'X', 'owner'] }, 'owner'),
    ['x']
  );
});

test('normalizeTaggedUsers: empty / missing / junk → null', () => {
  assert.strictEqual(normalizeTaggedUsers({}), null);
  assert.strictEqual(normalizeTaggedUsers({ taggedUsers: [] }), null);
  assert.strictEqual(normalizeTaggedUsers({ taggedUsers: [{}, { user: {} }, 42] }), null);
});

test('posts.tagged_users round-trips as JSON, null stays null (sqlite)', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE posts (shortcode TEXT UNIQUE, tagged_users TEXT)');
  const ins = db.prepare('INSERT INTO posts (shortcode, tagged_users) VALUES (?, ?)');
  const tags = normalizeTaggedUsers({ taggedUsers: ['alice', 'bob'] });
  ins.run('p1', tags ? JSON.stringify(tags) : null);
  ins.run('p2', normalizeTaggedUsers({}) ? '' : null);
  const r1 = db.prepare('SELECT tagged_users FROM posts WHERE shortcode = ?').get('p1');
  const r2 = db.prepare('SELECT tagged_users FROM posts WHERE shortcode = ?').get('p2');
  assert.deepStrictEqual(JSON.parse(r1.tagged_users), ['alice', 'bob']);
  assert.strictEqual(r2.tagged_users, null);
});

const { parseTaggedUsers } = require('./scraper');

test('parseTaggedUsers: valid JSON array → handles', () => {
  assert.deepStrictEqual(parseTaggedUsers('["alice","bob"]'), ['alice', 'bob']);
});

test('parseTaggedUsers: null/empty/malformed/non-array → [] (never throws)', () => {
  assert.deepStrictEqual(parseTaggedUsers(null), []);
  assert.deepStrictEqual(parseTaggedUsers(''), []);
  assert.deepStrictEqual(parseTaggedUsers('not json'), []);
  assert.deepStrictEqual(parseTaggedUsers('{"a":1}'), []);
  assert.deepStrictEqual(parseTaggedUsers('[1,2,"  ","ok"]'), ['ok']); // drops non-string/blank
});

test('mining shape: caption @mention + tagged handle de-dupe via seen Set', () => {
  // Mirrors the Phase-1 loop logic: a handle present in BOTH caption and
  // tagged_users is added once; new tagged handles are added with tagged_by source.
  const username = 'creator';
  const seen = new Set();
  const candidates = [];
  const rows = [{ caption: 'shot with @alice 🔥', tagged_users: '["alice","bob"]' }];
  for (const post of rows) {
    const mentions = (post.caption || '').match(/@([a-zA-Z0-9_.]{3,30})/g) || [];
    for (const m of mentions) {
      const h = m.replace('@', '').toLowerCase();
      if (!seen.has(h) && h !== username) { seen.add(h); candidates.push({ username: h, source: `mentioned_by:${username}` }); }
    }
    for (const h of parseTaggedUsers(post.tagged_users)) {
      if (!seen.has(h) && h !== username) { seen.add(h); candidates.push({ username: h, source: `tagged_by:${username}` }); }
    }
  }
  assert.deepStrictEqual(candidates.map(c => c.username), ['alice', 'bob']);
  assert.strictEqual(candidates.find(c => c.username === 'alice').source, 'mentioned_by:creator');
  assert.strictEqual(candidates.find(c => c.username === 'bob').source, 'tagged_by:creator');
});
