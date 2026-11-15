const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describeReel, redecideFromDescription, estimateCostUsd, cleanTranscript, cleanLayout } = require('./gemini-sort');
const { describeReactSpeech, cleanReactUtterances } = require('./gemini-sort');

const types = [
  { value: 'dance', label: 'Dance', description: 'The main activity is dancing to music.' },
  { value: 'talking', label: 'Talking', description: 'The person speaks their own words to camera in their live voice.' },
  { value: 'lipsync', label: 'Lip sync', description: 'The person mouths along to pre-recorded music or someone else\'s audio.' },
];
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
  assert.deepEqual(Object.keys(req.config.responseJsonSchema.properties), ['type', 'confidence', 'description', 'suggested_type', 'look_tags', 'audio_kind', 'transcript', 'layout']);
  assert.deepEqual(req.config.responseJsonSchema.properties.layout, { type: 'string', enum: ['self_filmed', 'split_screen', 'gameplay_overlay', 'needs_footage'] });
  assert.ok(req.config.responseJsonSchema.required.includes('layout'));
  assert.deepEqual(req.config.responseJsonSchema.properties.audio_kind, { type: 'string', enum: ['own_speech', 'music_or_trending_audio', 'other_voice', 'none'] });
  assert.ok(req.config.responseJsonSchema.required.includes('audio_kind'));
  assert.deepEqual(req.config.responseJsonSchema.properties.transcript, { anyOf: [{ type: 'string', maxLength: 4000 }, { type: 'null' }] });
  assert.ok(req.config.responseJsonSchema.required.includes('transcript'));
  assert.deepEqual(req.config.thinkingConfig, { thinkingLevel: 'MINIMAL' });
  const parts = req.contents[0].parts;
  assert.equal(parts[0].videoMetadata.fps, 1);
  assert.equal(parts[0].inlineData.mimeType, 'video/mp4');
  for (const type of types) {
    assert.ok(parts[1].text.includes(type.value));
    assert.ok(parts[1].text.includes(type.description));
  }
  for (const rule of [/mouth movement synced to a song or trending sound/, /someone else's voice/, /lip sync \(type lipsync\), NOT talking/]) assert.match(parts[1].text, rule);
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
test('cleanLayout accepts only the four supported layouts', () => {
  for (const layout of ['self_filmed', 'split_screen', 'gameplay_overlay', 'needs_footage']) {
    assert.equal(cleanLayout(layout), layout);
  }
  for (const value of [null, undefined, '', 'unknown', 'SELF_FILMED', ' self_filmed ', 0, {}, []]) {
    assert.equal(cleanLayout(value), null);
  }
});
test('describe parses layout from the video and explains each layout in its prompt', async t => {
  const filePath = await video(t);
  for (const layout of ['self_filmed', 'split_screen', 'gameplay_overlay', 'needs_footage', 'invalid', undefined]) {
    const client = fake({ text: JSON.stringify({ layout }) });
    const out = await describeReel({ filePath, types }, { client });
    assert.equal(out.layout, cleanLayout(layout));
    const text = client.calls[0].contents[0].parts[1].text;
    for (const rule of ['self_filmed', 'gaming desk or monitors behind her', 'split_screen', 'two or more separate video feeds', 'gameplay_overlay', 'person inset, overlaid or voicing over', 'needs_footage', 'green screen over a video or image', 'B-roll montage', "someone else's clip inserted"]) {
      assert.ok(text.includes(rule), rule);
    }
    assert.match(text, /eight JSON fields/);
  }
});
test('text-only redecide ignores layout even when requested or returned by the provider', async () => {
  const client = fake({ text: JSON.stringify({ layout: 'self_filmed' }) });
  const result = await redecideFromDescription({ description: 'A person speaking.', types, layout: 'split_screen' }, { client, transcribe: true });
  const request = client.calls[0];
  assert.equal('layout' in request.config.responseJsonSchema.properties, false);
  assert.equal(request.config.responseJsonSchema.required.includes('layout'), false);
  assert.doesNotMatch(request.contents[0].parts[0].text, /layout|self_filmed|split_screen/);
  assert.equal('layout' in result, false);
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

test('describe transcribes original speech in the same call with no lyrics or translation', async t => {
  const transcript = 'Hola, ¿cómo estás?\nEstoy bien.';
  const client = fake({ text: JSON.stringify({ audio_kind: 'own_speech', transcript }) });
  const result = await describeReel({ filePath: await video(t), types }, { client });
  assert.equal(client.calls.length, 1);
  assert.equal(result.transcript, transcript);
  const prompt = client.calls[0].contents[0].parts[1].text;
  for (const rule of [/clear speech by the person on screen/, /VERBATIM in plain text/, /line breaks between sentences or lines/, /at most 4000 characters/, /Return null when there is no clear speech or only music or lyrics/, /never transcribe song lyrics/, /Do not translate: keep the original language/, /No speaker labels, timestamps or commentary/]) {
    assert.match(prompt, rule);
  }
});

test('describe normalizes missing or empty speech to null and bounds overlong output', async t => {
  const filePath = await video(t);
  for (const value of [null, undefined, '', '   ', false]) {
    const result = await describeReel({ filePath, types }, { client: fake({ text: JSON.stringify({ audio_kind: 'own_speech', transcript: value }) }) });
    assert.equal(result.transcript, null);
  }
  const transcript = 'sentence. '.repeat(500);
  const result = await describeReel({ filePath, types }, { client: fake({ text: JSON.stringify({ audio_kind: 'own_speech', transcript }) }) });
  assert.equal(result.transcript.length, 3999);
  assert.ok(result.transcript.endsWith('.'));
  assert.ok(transcript.startsWith(result.transcript));
});

test('text-only redecide never requests or returns a transcript', async () => {
  const client = fake({ text: JSON.stringify({ transcript: 'Invented speech' }) });
  const result = await redecideFromDescription({ description: 'A person speaking.', types }, { client, transcribe: true });
  const request = client.calls[0];
  assert.equal('transcript' in request.config.responseJsonSchema.properties, false);
  assert.equal(request.config.responseJsonSchema.required.includes('transcript'), false);
  assert.doesNotMatch(request.contents[0].parts[0].text, /transcri/i);
  assert.equal('transcript' in result, false);
});

test('describe drops transcripts unless the video reports own speech', async t => {
  const filePath = await video(t);
  for (const audioKind of ['music_or_trending_audio', 'other_voice', 'none', 'invalid', null, undefined]) {
    const result = await describeReel({ filePath, types }, { client: fake({ text: JSON.stringify({ audio_kind: audioKind, transcript: 'Lyrics or dubbed words' }) }) });
    assert.equal(result.transcript, null);
    assert.equal(result.audioKind, ['music_or_trending_audio', 'other_voice', 'none'].includes(audioKind) ? audioKind : null);
  }
});

test('text redecide reuses verified audio and ignores invented audio output', async () => {
  const client = fake({ text: JSON.stringify({ audio_kind: 'own_speech' }) });
  const result = await redecideFromDescription({ types, audioKind: 'music_or_trending_audio' }, { client });
  assert.equal(result.audioKind, 'music_or_trending_audio');
  assert.equal('audio_kind' in client.calls[0].config.responseJsonSchema.properties, false);
  assert.match(client.calls[0].contents[0].parts[0].text, /"audio_kind":"music_or_trending_audio"/);
});

test('cleanTranscript truncates at sentence or word boundaries within 4000 characters', () => {
  const sentence = `${'a'.repeat(3998)}. `;
  assert.equal(cleanTranscript(`${sentence}More words.`), sentence.trimEnd());
  const words = 'word '.repeat(900);
  assert.equal(cleanTranscript(words), 'word '.repeat(800).trimEnd());
  assert.equal(cleanTranscript(`${'a'.repeat(4000)} remainder`), 'a'.repeat(4000));
  assert.equal(cleanTranscript('a'.repeat(4001)), null);
  const original = `你好。\n${'bonjour '.repeat(550)}`;
  const truncated = cleanTranscript(original);
  assert.ok(truncated.length <= 4000);
  assert.ok(truncated.endsWith('bonjour'));
  assert.ok(original.startsWith(truncated));
  assert.equal(cleanTranscript(' Hola.\r\nBien.\rGracias. '), 'Hola.\nBien.\nGracias.');
});

test('React speech uses existing client/model and strict role schema at temperature zero', async t => {
  const client = fake({ text: JSON.stringify({ utterances: [
    { start: 1, end: 2, text: 'Hola', role: 'creator' },
    { start: 2, end: 3, text: 'Hi', role: 'stranger' },
  ] }) });
  const result = await describeReactSpeech({ filePath: await video(t), durationSec: 3 }, { client, model: 'configured-model' });
  const request = client.calls[0];
  assert.equal(request.model, 'configured-model');
  assert.equal(request.config.temperature, 0);
  assert.equal(request.config.responseMimeType, 'application/json');
  assert.deepEqual(request.config.responseJsonSchema.properties.utterances.items.properties.role.enum, ['creator', 'stranger']);
  assert.equal(request.config.responseJsonSchema.additionalProperties, false);
  assert.match(request.contents[0].parts[1].text, /face in the bottom pane/);
  assert.match(request.contents[0].parts[1].text, /top pane \(the video call\)/);
  assert.deepEqual(result.utterances.map(item => item.role), ['creator', 'stranger']);
  assert.deepEqual(result.usage, { inTokens: 3400, outTokens: 80 });
});

test('React utterances clamp bounds, sort, and reject invalid or excess creator spans', () => {
  assert.deepEqual(cleanReactUtterances([
    { start: 2, end: 4, text: 'Later', role: 'stranger' },
    { start: -1, end: 1, text: 'a'.repeat(400), role: 'creator' },
  ], 3), [{ start: 0, end: 1, text: 'a'.repeat(300), role: 'creator' }, { start: 2, end: 3, text: 'Later', role: 'stranger' }]);
  for (const invalid of [null, {}, [{ start: '1', end: 2, text: 'x', role: 'creator' }],
    [{ start: 1, end: 2, text: 'x', role: 'unknown' }], [{ start: 1, end: Infinity, text: 'x', role: 'creator' }]]) {
    assert.throws(() => cleanReactUtterances(invalid, 3), /Invalid React/);
  }
  assert.throws(() => cleanReactUtterances(Array.from({ length: 201 }, () => ({ start: 0, end: 1, text: 'x', role: 'creator' })), 3), /Too many creator/);
});

test('React upload waits for ACTIVE, uses abort signal and cleans uploaded file', async t => {
  const events = [], controller = new AbortController();
  const client = fake({ text: '{"utterances":[]}' });
  client.files = {
    upload: async request => { events.push('upload'); assert.equal(request.config.abortSignal, controller.signal); return { name: 'react/video', state: 'PROCESSING' }; },
    get: async () => { events.push('get'); return { name: 'react/video', state: 'ACTIVE', uri: 'fake://react' }; },
    delete: async () => { events.push('delete'); },
  };
  const result = await describeReactSpeech({ filePath: await video(t, 18 * 1024 * 1024 + 1), durationSec: 3 }, { client, signal: controller.signal });
  assert.deepEqual(result.utterances, []);
  assert.equal(client.calls[0].config.abortSignal, controller.signal);
  assert.deepEqual(events, ['upload', 'get', 'delete']);
});

test('React requests never retry 403 and abort before calling the provider', async t => {
  const filePath = await video(t);
  let calls = 0;
  const client = { models: { generateContent: async () => { calls++; throw Object.assign(new Error('forbidden'), { status: 403 }); } } };
  await assert.rejects(describeReactSpeech({ filePath, durationSec: 3 }, { client }), /forbidden/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(describeReactSpeech({ filePath, durationSec: 3 }, { client, signal: controller.signal }), /abort/i);
  assert.equal(calls, 1);
});
