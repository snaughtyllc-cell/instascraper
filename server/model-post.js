const MODEL_POST_FIELDS = [
  'id', 'shortcode', 'account_handle', 'posted_at', 'caption',
  'view_count', 'like_count', 'comment_count', 'er_percent', 'er_label',
  'post_url', 'content_type', 'niche',
];

const MODEL_ASSIGNMENT_FIELDS = [
  'assigned_at', 'assignment_status', 'feedback', 'feedback_notes', 'feedback_at',
];

function toModelPost(row = {}, extras = []) {
  const out = {};
  for (const field of [...MODEL_POST_FIELDS, ...extras]) {
    if (Object.prototype.hasOwnProperty.call(row, field)) out[field] = row[field];
  }
  return out;
}

function toModelPosts(rows, extras = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => toModelPost(row, extras));
}

module.exports = { MODEL_POST_FIELDS, MODEL_ASSIGNMENT_FIELDS, toModelPost, toModelPosts };
