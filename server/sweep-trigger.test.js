const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

test('runThumbnailSweep swallows sweep errors and records status', async () => {
  // stub ./thumbnails before requiring scheduler
  const orig = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === './thumbnails') return { sweepThumbnails: async () => { throw new Error('x'); } };
    return orig.apply(this, arguments);
  };
  delete require.cache[require.resolve('./scheduler')];
  const sched = require('./scheduler');
  await assert.doesNotReject(() => sched.runThumbnailSweep());
  Module._load = orig;
  delete require.cache[require.resolve('./scheduler')];
});
