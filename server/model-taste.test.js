const { test } = require('node:test');
const assert = require('node:assert/strict');
const { featuresOfPost, affinity, recomputeTaste, loadTaste, tasteForFeed, creatorTaste } = require('./model-taste');
const { makeWorkspaceDb } = require('./test-support/workspace-db');

test('featuresOfPost includes type, unique look tags and lowercase creator', () => {
  assert.deepEqual(featuresOfPost({ content_type: 'talking', ai_look_tags: '["Brunette","brunette","bedroom"]', account_handle: 'MIA.Talks' }),
    ['type:talking', 'tag:brunette', 'tag:bedroom', 'creator:mia.talks']);
  assert.deepEqual(featuresOfPost({ ai_look_tags: 'bad' }), []);
});

test('affinity(2,0)=0.5, affinity(0,1)=-0.333, affinity(0,0)=0', () => {
  assert.equal(affinity(2, 0), 0.5);
  assert.equal(affinity(0, 1), -1 / 3);
  assert.equal(affinity(0, 0), 0);
});

test('recomputeTaste counts saved/want_to_make as +1 once and not_my_style as -1', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`INSERT INTO posts (id,account_handle,content_type,ai_look_tags) VALUES
    (1,'Mia','talking','["brunette","brunette"]'),(2,'mia','talking','["brunette"]'),
    (3,'other','dance','["glam"]'),(4,'ignored','talking','["emo"]');
    INSERT INTO model_saved_posts VALUES (1,1),(2,4);
    INSERT INTO model_post_feedback VALUES (1,1,'want_to_make'),(1,2,'want_to_make'),(1,3,'not_my_style'),(1,4,'done'),(2,3,'want_to_make');`);
  assert.deepEqual(await recomputeTaste(pool, 1), { features: 6 });
  const rows = pool.sqlite.prepare('SELECT feature,affinity,positives,negatives FROM model_taste WHERE model_id=1 ORDER BY feature').all();
  assert.deepEqual(rows, [
    { feature: 'creator:mia', affinity: 0.5, positives: 2, negatives: 0 },
    { feature: 'creator:other', affinity: -1 / 3, positives: 0, negatives: 1 },
    { feature: 'tag:brunette', affinity: 0.5, positives: 2, negatives: 0 },
    { feature: 'tag:glam', affinity: -1 / 3, positives: 0, negatives: 1 },
    { feature: 'type:dance', affinity: -1 / 3, positives: 0, negatives: 1 },
    { feature: 'type:talking', affinity: 0.5, positives: 2, negatives: 0 },
  ]);
  assert.deepEqual(await loadTaste(pool, 1), new Map(rows.map(row => [row.feature, row.affinity])));
  pool.sqlite.exec('DELETE FROM model_saved_posts WHERE model_id=1; DELETE FROM model_post_feedback WHERE model_id=1');
  assert.deepEqual(await recomputeTaste(pool, 1), { features: 0 });
  assert.equal((await loadTaste(pool, 1)).size, 0, 'removed signals remove stale features');
});

test('failed taste replacement rolls back the existing rows', async t => {
  const pool = await makeWorkspaceDb(t);
  pool.sqlite.exec(`INSERT INTO posts (id,account_handle) VALUES (1,'mia');
    INSERT INTO model_saved_posts VALUES (1,1);
    INSERT INTO model_taste (model_id,feature,affinity) VALUES (1,'creator:old',0.5);`);
  const query = pool.query;
  pool.query = async (sql, params) => {
    if (/INSERT INTO model_taste/.test(sql)) throw new Error('write failed');
    return query(sql, params);
  };
  await assert.rejects(recomputeTaste(pool, 1), /write failed/);
  assert.deepEqual(await loadTaste(pool, 1), new Map([['creator:old', 0.5]]));
});

test('feed taste uses top 20 by absolute affinity per kind, ignoring deleted tags', () => {
  const taste = new Map(Array.from({ length: 25 }, (_, i) => [`type:t${i}`, -i / 30]));
  taste.set('tag:deleted', 0.9);
  taste.set('tag:brunette', 0.5);
  taste.set('creator:mia', 0.4);
  const ranked = tasteForFeed(taste, new Set(['brunette']));
  assert.equal(ranked.types.length, 20);
  assert.deepEqual(ranked.types[0], ['t24', -24 / 30]);
  assert.deepEqual(ranked.tags, [['brunette', 0.5]]);
  assert.deepEqual(ranked.creators, [['mia', 0.4]]);
});

test('creator taste includes creator affinity plus tag affinities weighted by share', () => {
  const taste = new Map([['creator:mia', 0.5], ['tag:brunette', 0.4], ['tag:emo', -0.2], ['type:talking', 0.9]]);
  assert.ok(Math.abs(creatorTaste(taste, 'MIA', new Map([['brunette', 0.5], ['emo', 1]])) - 0.5) < 1e-12);
});

test('Postgres recompute locks the model before reading signals', async t => {
  const pool = await makeWorkspaceDb(t);
  pool._pool = {};
  const queries = [];
  const query = pool.query;
  pool.query = async (sql, params) => {
    queries.push(sql);
    return query(sql.replace(/ FOR UPDATE$/, ''), params);
  };
  await recomputeTaste(pool, 1);
  assert.match(queries[0], /^SELECT id FROM models WHERE id = \$1 FOR UPDATE$/);
});
