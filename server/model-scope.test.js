const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { modelScopeClause } = require('./model-scope');

function visible(t, { creators = [], handles = ['mia.talks', 'other'] } = {}) {
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE model_creators (model_id INTEGER, username TEXT); CREATE TABLE posts (account_handle TEXT)');
  for (const name of creators) sqlite.prepare('INSERT INTO model_creators VALUES (1, ?)').run(name);
  for (const name of handles) sqlite.prepare('INSERT INTO posts VALUES (?)').run(name);
  const scope = modelScopeClause('posts', 1);
  assert.deepEqual([...scope.clause.matchAll(/\$(\d+)/g)].map(m => Number(m[1])), [1, 2]);
  assert.deepEqual(scope.params(1), [1, 1]);
  return sqlite.prepare(`SELECT account_handle FROM posts WHERE ${scope.clause}`.replace(/\$\d+/g, '?'))
    .all(...scope.params(1)).map(row => row.account_handle);
}

test('model with no creators sees all', t => assert.deepEqual(visible(t), ['mia.talks', 'other']));
test('model with creators sees only theirs', t => assert.deepEqual(visible(t, { creators: ['mia.talks'] }), ['mia.talks']));
test('scope matches handles case-insensitively', t => assert.deepEqual(visible(t, { creators: ['mia.talks'], handles: ['Mia.Talks', 'other'] }), ['Mia.Talks']));
