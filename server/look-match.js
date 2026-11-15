const { parseTagList } = require('./look-tags');

function reelLookMatch(modelTags, reelTags) {
  if (!modelTags.length) return 0;
  const tags = new Set(reelTags);
  return modelTags.filter(tag => tags.has(tag)).length / modelTags.length;
}

function creatorLookMatch(modelTags, profile) {
  if (!modelTags.length) return 0;
  return modelTags.reduce((sum, tag) => sum + (profile.get(tag) || 0), 0) / modelTags.length;
}

function profileOfReels(reels) {
  const profile = new Map();
  for (const reel of reels) {
    for (const tag of parseTagList(reel.ai_look_tags)) profile.set(tag, (profile.get(tag) || 0) + 1);
  }
  for (const [tag, count] of profile) profile.set(tag, count / reels.length);
  return profile;
}

function candidateLookProfile(reels) {
  return profileOfReels(reels.filter(reel => !reel.ai_error && (reel.ai_classified_at || Number.isFinite(reel.ai_confidence))));
}

async function creatorLookProfiles(pool, usernames) {
  const handles = [...new Set(usernames.map(name => name.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  const profiles = new Map(handles.map(handle => {
    const profile = new Map();
    profile.manual = new Set();
    return [handle, profile];
  }));
  if (!handles.length) return profiles;
  const known = new Set((await pool.query('SELECT value FROM look_tags')).rows.map(row => row.value));
  const placeholders = handles.map((_, index) => `$${index + 1}`).join(',');
  const posts = await pool.query(`SELECT LOWER(TRIM(account_handle)) AS username, ai_look_tags FROM posts
    WHERE LOWER(TRIM(account_handle)) IN (${placeholders}) AND sort_status IN ('auto', 'manual')
      AND (soft_deleted = 0 OR soft_deleted IS NULL) AND (archived = 0 OR archived IS NULL)`, handles);
  const reels = new Map(handles.map(handle => [handle, []]));
  for (const post of posts.rows) reels.get(post.username).push(post);
  for (const [handle, items] of reels) {
    for (const [tag, share] of profileOfReels(items)) if (known.has(tag)) profiles.get(handle).set(tag, share);
  }
  const manual = await pool.query(`SELECT LOWER(TRIM(username)) AS username, tag FROM creator_look_tags
    WHERE LOWER(TRIM(username)) IN (${placeholders})`, handles);
  for (const { username, tag } of manual.rows) {
    if (!known.has(tag)) continue;
    profiles.get(username).set(tag, 1);
    profiles.get(username).manual.add(tag);
  }
  return profiles;
}

function creatorLookList(profile) {
  return [...profile].map(([tag, share]) => ({ tag, share, manual: profile.manual?.has(tag) || false }))
    .sort((a, b) => b.share - a.share || a.tag.localeCompare(b.tag));
}

async function validateCreatorLookTag(pool, value) {
  const tag = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!tag) return { ok: false, error: 'Tag is required' };
  const result = await pool.query('SELECT value FROM look_tags WHERE value = $1', [tag]);
  return result.rows.length ? { ok: true, tag } : { ok: false, error: 'Unknown look tag' };
}

module.exports = { reelLookMatch, creatorLookProfiles, creatorLookMatch, candidateLookProfile, creatorLookList, validateCreatorLookTag };
