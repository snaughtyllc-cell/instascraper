const { test } = require('node:test');
const assert = require('node:assert');
const { isErrorStubResponse } = require('./scraper');

// When Apify's IG actors can't return real posts, they emit a single dataset item that is
// an ERROR STUB — the run still finishes SUCCEEDED. Two shapes seen in prod (jobs #268–#286):
//   1. proxy block:  { requestErrorMessages: ["Request blocked...", "BlockedError: BLOCKED"] }
//   2. not found:    { error: "not_found", errorDescription: "Post does not exist" }
// isErrorStubResponse detects a response where EVERY item is such a stub (no real posts,
// even after the generic fallback), so the scrape is recorded as a retryable failure
// instead of a misleading "completed — 0 reels".
const blockedStub = [{
  url: 'https://www.instagram.com/cozymochixo',
  requestErrorMessages: ['Request blocked, retrying it again with different session', 'BlockedError: BLOCKED'],
}];
const notFoundStub = [{ url: 'https://www.instagram.com/tonylore1', username: 'tonylore1', error: 'not_found', errorDescription: 'Post does not exist' }];
const realReel = { type: 'Video', productType: 'clips', shortCode: 'abc', videoUrl: 'https://x/v.mp4', ownerUsername: 'someone' };

test('isErrorStubResponse: a proxy-block stub response is an error stub', () => {
  assert.strictEqual(isErrorStubResponse(blockedStub), true);
});

test('isErrorStubResponse: a not_found/error stub response is an error stub', () => {
  assert.strictEqual(isErrorStubResponse(notFoundStub), true);
});

test('isErrorStubResponse: real reels are not an error stub', () => {
  assert.strictEqual(isErrorStubResponse([realReel, { ...realReel, shortCode: 'def' }]), false);
});

test('isErrorStubResponse: an empty response is NOT a stub (legit "no reels")', () => {
  assert.strictEqual(isErrorStubResponse([]), false);
});

test('isErrorStubResponse: a mix of real posts and a stub is not a block (we got data)', () => {
  assert.strictEqual(isErrorStubResponse([realReel, ...blockedStub]), false);
  assert.strictEqual(isErrorStubResponse([realReel, ...notFoundStub]), false);
});

test('isErrorStubResponse: empty requestErrorMessages / empty error string are not stubs', () => {
  assert.strictEqual(isErrorStubResponse([{ url: 'x', requestErrorMessages: [] }]), false);
  assert.strictEqual(isErrorStubResponse([{ url: 'x', error: '' }]), false);
});

test('isErrorStubResponse: non-array / nullish input is not a stub (defensive)', () => {
  assert.strictEqual(isErrorStubResponse(null), false);
  assert.strictEqual(isErrorStubResponse(undefined), false);
  assert.strictEqual(isErrorStubResponse({}), false);
});
