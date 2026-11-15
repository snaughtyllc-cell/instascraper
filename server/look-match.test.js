const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeWorkspaceDb } = require('./test-support/workspace-db');
const { reelLookMatch, creatorLookProfiles, creatorLookMatch, candidateLookProfile, validateCreatorLookTag } = require('./look-match');

test('reelLookMatch uses intersection share and empty model scores zero', () => {
  assert.equal(reelLookMatch(['brunette', 'emo'], ['brunette', 'bedroom']), 0.5);
  assert.equal(reelLookMatch([], ['brunette']), 0);
});

test('creatorLookProfiles counts sorted reels and manual tags override to one', async t => {
  const db = await makeWorkspaceDb(t);
  db.sqlite.exec(`INSERT INTO look_tags (value, label, category) VALUES ('asian', 'Asian', 'custom');
    INSERT INTO posts (id, account_handle, sort_status, ai_look_tags) VALUES
      (1, 'Creator', 'auto', '["brunette"]'), (2, 'creator', 'manual', '["brunette","brunette"]'),
      (3, 'creator', 'auto', '[]'), (4, 'creator', 'manual', NULL),
      (5, 'creator', 'unsorted', '["brunette"]'), (6, 'creator', 'needs_look', '["brunette"]');
    INSERT INTO posts (id, account_handle, sort_status, ai_look_tags, soft_deleted, archived) VALUES
      (7, 'creator', 'auto', '["brunette"]', 1, 0), (8, 'creator', 'auto', '["brunette"]', 0, 1);
    INSERT INTO creator_look_tags (username, tag) VALUES ('creator', 'asian')`);
  const profiles = await creatorLookProfiles(db, ['creator', 'missing']);
  assert.equal(profiles.get('creator').get('brunette'), 0.5);
  assert.equal(profiles.get('creator').get('asian'), 1);
  assert.deepEqual([...profiles.get('missing')], []);
});

test('creatorLookMatch averages model tags including absent tags', () => {
  assert.equal(creatorLookMatch(['brunette', 'emo'], new Map([['brunette', 0.5]])), 0.25);
  assert.equal(creatorLookMatch([], new Map([['brunette', 0.5]])), 0);
});

test('deleted tag ignored in scores', async t => {
  const db = await makeWorkspaceDb(t);
  db.sqlite.exec(`INSERT INTO posts (id, account_handle, sort_status, ai_look_tags) VALUES (1, 'creator', 'auto', '["brunette","emo"]');
    INSERT INTO creator_look_tags (username, tag) VALUES ('creator', 'emo');
    DELETE FROM look_tags WHERE value = 'emo'`);
  const profile = (await creatorLookProfiles(db, ['creator'])).get('creator');
  assert.equal(profile.has('emo'), false);
  assert.equal(creatorLookMatch(['brunette', 'emo'], profile), 0.5);
});

test('candidateLookProfile counts each tag once per reel', () => {
  assert.deepEqual([...candidateLookProfile([{ ai_confidence: 0.9, ai_look_tags: '["brunette","brunette"]' }, { ai_classified_at: '2026-11-15', ai_look_tags: '[]' }])], [['brunette', 0.5]]);
  assert.deepEqual([...candidateLookProfile([])], []);
});

test('candidateLookProfile ignores unsorted and failed reels in its denominator', () => {
  const profile = candidateLookProfile([
    { ai_classified_at: '2026-11-15', ai_look_tags: '["brunette"]' },
    { ai_look_tags: null },
    { ai_classified_at: '2026-11-15', ai_error: 'failed', ai_look_tags: null },
  ]);
  assert.equal(profile.get('brunette'), 1);
});

test('a tag on every one of nine candidate reels has an exact share of one', () => {
  const profile = candidateLookProfile(Array.from({ length: 9 }, () => ({ ai_confidence: 0.9, ai_look_tags: '["brunette"]' })));
  assert.equal(profile.get('brunette'), 1);
  assert.ok([...profile.values()].every(share => share <= 1));
});

test('manual creator tag must exist in vocabulary', async t => {
  const db = await makeWorkspaceDb(t);
  assert.deepEqual(await validateCreatorLookTag(db, 'BRUNETTE'), { ok: true, tag: 'brunette' });
  assert.equal((await validateCreatorLookTag(db, 'unknown')).ok, false);
  db.sqlite.exec("INSERT INTO look_tags (value, label, category) VALUES ('asian', 'Asian', 'custom')");
  assert.deepEqual(await validateCreatorLookTag(db, 'asian'), { ok: true, tag: 'asian' });
});
