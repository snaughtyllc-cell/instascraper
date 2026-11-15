const { parseTagList } = require('./look-tags');

function featuresOfPost(post = {}) {
  const features = [];
  if (post.content_type) features.push(`type:${post.content_type}`);
  features.push(...parseTagList(post.ai_look_tags).map(tag => `tag:${tag}`));
  const handle = String(post.account_handle || '').trim().toLowerCase();
  if (handle) features.push(`creator:${handle}`);
  return features;
}

function affinity(positives, negatives) {
  return (positives - negatives) / (positives + negatives + 2);
}

async function recomputeTaste(db, modelId) {
  return db.transaction(async tx => {
    // Serialize recomputes for one model across PostgreSQL connections. SQLite's
    // adapter already serializes transactions on its single connection.
    if (db._pool) await tx.query('SELECT id FROM models WHERE id = $1 FOR UPDATE', [modelId]);
    const saved = await tx.query(`SELECT posts.* FROM model_saved_posts s
      JOIN posts ON posts.id = s.post_id WHERE s.model_id = $1`, [modelId]);
    const feedback = await tx.query(`SELECT posts.*, f.feedback FROM model_post_feedback f
      JOIN posts ON posts.id = f.post_id WHERE f.model_id = $1
      AND f.feedback IN ('want_to_make','not_my_style')`, [modelId]);
    const positive = new Map(saved.rows.map(post => [post.id, post]));
    const negative = new Map();
    for (const post of feedback.rows) {
      (post.feedback === 'want_to_make' ? positive : negative).set(post.id, post);
    }
    const counts = new Map();
    for (const [posts, kind] of [[positive, 'positives'], [negative, 'negatives']]) {
      for (const post of posts.values()) {
        for (const feature of featuresOfPost(post)) {
          if (!counts.has(feature)) counts.set(feature, { positives: 0, negatives: 0 });
          counts.get(feature)[kind]++;
        }
      }
    }
    await tx.query('DELETE FROM model_taste WHERE model_id = $1', [modelId]);
    const now = new Date().toISOString();
    for (const [feature, { positives, negatives }] of counts) {
      await tx.query(`INSERT INTO model_taste (model_id,feature,affinity,positives,negatives,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, [modelId, feature, affinity(positives, negatives), positives, negatives, now]);
    }
    return { features: counts.size };
  });
}

async function refreshTaste(db, modelId) {
  try { await recomputeTaste(db, modelId); }
  catch (error) { console.error(`[Taste] model=${modelId}: ${error.message}`); }
}

async function loadTaste(db, modelId) {
  const { rows } = await db.query('SELECT feature, affinity FROM model_taste WHERE model_id = $1 ORDER BY feature', [modelId]);
  return new Map(rows.map(row => [row.feature, Number(row.affinity)]));
}

function tasteForFeed(taste, knownTags) {
  const result = { types: [], tags: [], creators: [] };
  const kinds = { type: 'types', tag: 'tags', creator: 'creators' };
  for (const [feature, score] of taste) {
    const colon = feature.indexOf(':');
    const kind = feature.slice(0, colon), value = feature.slice(colon + 1);
    if (!kinds[kind] || !value || !Number.isFinite(score) || !score) continue;
    if (kind === 'tag' && knownTags && !knownTags.has(value)) continue;
    result[kinds[kind]].push([value, score]);
  }
  for (const kind of Object.keys(result)) {
    result[kind] = result[kind].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 20);
  }
  return result;
}

function creatorTaste(taste, username, profile) {
  let score = taste.get(`creator:${String(username).trim().toLowerCase()}`) || 0;
  for (const [tag, share] of profile) score += (taste.get(`tag:${tag}`) || 0) * share;
  return score;
}

module.exports = { featuresOfPost, affinity, recomputeTaste, refreshTaste, loadTaste, tasteForFeed, creatorTaste };
