const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describeReel, redecideFromDescription, estimateCostUsd } = require('./gemini-sort');

const types = [{ value: 'dance', label: 'Dance' }, { value: 'talking', label: 'Talking' }];
function fake(result = {}) {
  const calls = [];
  return { calls, models: { generateContent: async args => {
    calls.push(args);
    return { text: JSON.stringify({ type: 'dance', confidence: 0.9, description: 'A dance.', suggested_type: null }),
      usageMetadata: { promptTokenCount: 3400, candidatesTokenCount: 80 }, ...result };
  } } };
}
async function video(t, size = 5) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-sort-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reel.mp4');
  await fs.writeFile(file, Buffer.alloc(size));
  return file;
}
test('request uses low media resolution, json schema and the model', async t => {
  const client = fake();
  const out = await describeReel({ filePath: await video(t), caption: 'caption', handle: 'creator', types }, { client, model: 'gemini-3.5-flash-lite' });
  const req = client.calls[0];
  assert.equal(req.model, 'gemini-3.5-flash-lite');
  assert.equal(req.config.mediaResolution, 'MEDIA_RESOLUTION_LOW');
  assert.equal(req.config.responseMimeType, 'application/json');
  assert.deepEqual(Object.keys(req.config.responseJsonSchema.properties), ['type', 'confidence', 'description', 'suggested_type', 'look_tags']);
  assert.deepEqual(req.config.thinkingConfig, { thinkingLevel: 'MINIMAL' });
  const parts = req.contents[0].parts;
  assert.equal(parts[0].videoMetadata.fps, 1);
  assert.equal(parts[0].inlineData.mimeType, 'video/mp4');
  for (const type of types) assert.ok(parts[1].text.includes(type.value));
  assert.deepEqual(out.usage, { inTokens: 3400, outTokens: 80 });
});
test('unknown type coerced to null', async () => {
  const client = fake({ text: '{"type":"lifestyle","confidence":0.9,"description":"Walking","suggested_type":"Lifestyle"}' });
  const out = await redecideFromDescription({ description: 'Walking', caption: '', types }, { client });
  assert.equal(out.type, null);
  assert.equal(out.suggestedType, 'Lifestyle');
  assert.equal(client.calls[0].contents[0].parts.length, 1);
});
test('confidence clamped to 0..1', async () => {
  for (const [confidence, expected] of [[2, 1], [-2, 0], ['bad', 0]]) {
    const client = fake({ text: JSON.stringify({ type: 'dance', confidence }) });
    assert.equal((await redecideFromDescription({ types }, { client })).confidence, expected);
  }
});
test('malformed JSON throws', async () => {
  await assert.rejects(redecideFromDescription({ types }, { client: fake({ text: '{no' }) }), SyntaxError);
});
test('estimateCostUsd uses input and output prices', () => {
  assert.ok(Math.abs(estimateCostUsd({ inTokens: 3400, outTokens: 80 }, { priceInPerM: 0.30, priceOutPerM: 2.50 }) - 0.00122) < 1e-10);
});
test('large video waits for ACTIVE and deletes upload after generation failure', async t => {
  const events = [];
  const client = fake();
  client.files = {
    upload: async () => { events.push('upload'); return { name: 'files/fake', state: 'PROCESSING' }; },
    get: async () => { events.push('get'); return { name: 'files/fake', state: 'ACTIVE', uri: 'fake://video', mimeType: 'video/mp4' }; },
    delete: async () => events.push('delete'),
  };
  client.models.generateContent = async args => { events.push('generate'); assert.equal(args.contents[0].parts[0].videoMetadata.fps, 1); throw new Error('bad generation'); };
  await assert.rejects(describeReel({ filePath: await video(t, 18 * 1024 * 1024 + 1), types }, { client }), /bad generation/);
  assert.deepEqual(events, ['upload', 'get', 'generate', 'delete']);
});
test('403 is never retried', async () => {
  let calls = 0;
  const client = { models: { generateContent: async () => { calls++; throw Object.assign(new Error('forbidden'), { status: 403 }); } } };
  await assert.rejects(redecideFromDescription({ types }, { client }), /forbidden/);
  assert.equal(calls, 1);
});
test('empty type list permits only null without an invalid empty enum', async () => {
  const client = fake({ text: '{"type":null,"confidence":0,"description":"Walking","suggested_type":"Lifestyle"}' });
  await redecideFromDescription({ types: [] }, { client });
  assert.deepEqual(client.calls[0].config.responseJsonSchema.properties.type, { type: 'null' });
});

const lookTags = [
  { value: 'brunette', label: 'Brunette', category: 'hair' },
  { value: 'bedroom', label: 'Bedroom', category: 'setting' },
  { value: 'private-custom', label: 'Private custom', category: 'custom' },
];
test('schema lists only non-custom look tags, max 5', async () => {
  const client = fake();
  await redecideFromDescription({ types, lookTags }, { client });
  const schema = client.calls[0].config.responseJsonSchema;
  assert.deepEqual(schema.properties.look_tags, { type: 'array', items: { type: 'string', enum: ['brunette', 'bedroom'] }, maxItems: 5 });
  assert.ok(schema.required.includes('look_tags'));
  assert.ok(!JSON.stringify(client.calls[0]).includes('private-custom'));
  assert.ok(!JSON.stringify(client.calls[0]).includes('Private custom'));
});
test('prompt forbids inferring ethnicity, age and body attributes', async t => {
  const client = fake();
  await describeReel({ filePath: await video(t), types, lookTags }, { client });
  const prompt = client.calls[0].contents[0].parts[1].text;
  assert.match(prompt, /never infer ethnicity/);
  for (const forbidden of ['race', 'age', 'body type', 'other personal attributes']) assert.ok(prompt.includes(forbidden));
  for (const visible of ['hair', 'makeup', 'fashion', 'aesthetic', 'setting']) assert.ok(prompt.includes(visible));
});
test('unknown and custom look tags dropped', async () => {
  const client = fake({ text: JSON.stringify({ type: 'dance', confidence: 0.9, look_tags: ['brunette', 'private-custom', 'unknown', 'bedroom', 'brunette'] }) });
  const result = await redecideFromDescription({ types, lookTags }, { client });
  assert.deepEqual(result.lookTags, ['brunette', 'bedroom']);
});
test('no vocabulary → look_tags enum empty and result []', async () => {
  const client = fake({ text: JSON.stringify({ look_tags: ['brunette'] }) });
  const result = await redecideFromDescription({ types }, { client });
  assert.deepEqual(client.calls[0].config.responseJsonSchema.properties.look_tags.items.enum, []);
  assert.deepEqual(result.lookTags, []);
});
test('look tags capped at five and malformed output becomes an empty list', async () => {
  const vocabulary = Array.from({ length: 8 }, (_, i) => ({ value: `tag-${i}`, category: 'aesthetic' }));
  const client = fake({ text: JSON.stringify({ look_tags: vocabulary.map(tag => tag.value) }) });
  assert.equal((await redecideFromDescription({ types, lookTags: vocabulary }, { client })).lookTags.length, 5);
  assert.deepEqual((await redecideFromDescription({ types, lookTags }, { client: fake({ text: '{"look_tags":"brunette"}' }) })).lookTags, []);
});
