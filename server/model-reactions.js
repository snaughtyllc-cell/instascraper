async function upsertFeedback(db, { modelId, postId, feedback, notes = '', nowIso = new Date().toISOString() }) {
  await db.query(
    `INSERT INTO model_post_feedback (model_id, post_id, feedback, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (model_id, post_id) DO UPDATE SET feedback = excluded.feedback, notes = excluded.notes, updated_at = excluded.updated_at`,
    [modelId, postId, feedback, notes, nowIso, nowIso]);
}

async function applyModelReaction(db, { modelId, postId, reaction, nowIso = new Date().toISOString() }) {
  if (!['save', 'unsave', 'not_interested'].includes(reaction)) throw new Error('Invalid model reaction');
  return db.transaction(async (tx) => {
    if (reaction === 'save') {
      await tx.query(
        'INSERT INTO model_saved_posts (model_id, post_id, saved_at) VALUES ($1,$2,$3) ON CONFLICT (model_id, post_id) DO UPDATE SET saved_at = excluded.saved_at',
        [modelId, postId, nowIso]);
      await upsertFeedback(tx, { modelId, postId, feedback: 'want_to_make', nowIso });
      return { saved: true, feedback: 'want_to_make' };
    }

    await tx.query('DELETE FROM model_saved_posts WHERE model_id = $1 AND post_id = $2', [modelId, postId]);
    if (reaction === 'unsave') {
      await tx.query(
        "DELETE FROM model_post_feedback WHERE model_id = $1 AND post_id = $2 AND feedback = 'want_to_make'",
        [modelId, postId]);
      return { saved: false, feedback: null };
    }

    await upsertFeedback(tx, { modelId, postId, feedback: 'not_my_style', nowIso });
    return { saved: false, feedback: 'not_my_style' };
  });
}

module.exports = { applyModelReaction, upsertFeedback };
