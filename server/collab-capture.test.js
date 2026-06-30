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
