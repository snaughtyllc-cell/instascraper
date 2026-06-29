const { test } = require('node:test');
const assert = require('node:assert');
const { isTransientDbError, classifyDbError, asyncHandler, dbErrorMiddleware } = require('./db-health');

test('classifies transient vs auth vs other', () => {
  assert.equal(isTransientDbError({ code: 'ENOTFOUND' }), true);
  assert.equal(isTransientDbError({ code: 'ECONNREFUSED' }), true);
  assert.equal(isTransientDbError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isTransientDbError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientDbError({ code: '57P03' }), true);
  assert.equal(isTransientDbError({ code: '08006' }), true);
  assert.equal(isTransientDbError({ code: '28P01' }), false);
  assert.equal(classifyDbError({ code: 'ENOTFOUND' }), 'transient');
  assert.equal(classifyDbError({ code: '28P01' }), 'auth');
  assert.equal(classifyDbError({ code: '28000' }), 'auth');
  assert.equal(classifyDbError({ code: '3D000' }), 'auth');
  assert.equal(classifyDbError({ message: 'syntax error' }), 'other');
});

test('asyncHandler forwards rejections to next', async () => {
  const err = new Error('boom');
  let passed;
  const handler = asyncHandler(async () => { throw err; });
  await handler({}, {}, (e) => { passed = e; });
  assert.equal(passed, err);
});

test('dbErrorMiddleware maps transient DB errors to 503 else 500', () => {
  const mk = () => { let code, body; return { status(c){code=c;return this;}, json(b){body=b;return this;}, get code(){return code;}, get body(){return body;} }; };
  let res = mk();
  dbErrorMiddleware({ code: 'ECONNREFUSED' }, {}, res, () => {});
  assert.equal(res.code, 503);
  res = mk();
  dbErrorMiddleware({ message: 'real bug' }, {}, res, () => {});
  assert.equal(res.code, 500);
});

test('dbErrorMiddleware delegates to next when headers already sent', () => {
  let statusCalled = false, jsonCalled = false, nextArg;
  const res = { headersSent: true, status() { statusCalled = true; return this; }, json() { jsonCalled = true; return this; } };
  dbErrorMiddleware(new Error('late'), {}, res, (e) => { nextArg = e; });
  assert.equal(statusCalled, false);
  assert.equal(jsonCalled, false);
  assert.ok(nextArg instanceof Error);
});
