const { test } = require('node:test');
const assert = require('node:assert');
const { MODEL_ASSIGNMENT_FIELDS, toModelPost } = require('./model-post');

test('model post DTO keeps creator-facing fields and drops internal/admin fields', () => {
  const dto = toModelPost({
    id: 7,
    shortcode: 'abc',
    account_handle: 'creator',
    caption: 'caption',
    view_count: 123,
    niche: 'talking',
    post_url: 'https://instagram.com/reel/abc',
    notes: 'staff-only note',
    tag: 'recreate',
    query: 'internal scrape query',
    video_url: 'signed-secret-url',
    thumbnail_url: 'signed-thumbnail-url',
    video_cache_error: 'disk details',
  });
  assert.deepStrictEqual(dto, {
    id: 7,
    shortcode: 'abc',
    account_handle: 'creator',
    caption: 'caption',
    view_count: 123,
    post_url: 'https://instagram.com/reel/abc',
    niche: 'talking',
  });
});

test('assignment DTO adds only approved assignment metadata', () => {
  const dto = toModelPost({ id: 2, assigned_at: 'now', feedback: 'want_to_make', password_hash: 'nope' }, MODEL_ASSIGNMENT_FIELDS);
  assert.deepStrictEqual(dto, { id: 2, assigned_at: 'now', feedback: 'want_to_make' });
});
