const { test } = require('node:test');
const assert = require('node:assert');
const { transcriptShingles, overlap, findRepeatedAudio, decideTalkingVsLipSync } = require('./lipsync-signals');

const words = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
const unrelated = 'apple banana cherry date elderberry fig grape honeydew iris jasmine kale lemon melon nectarine orange';

test('transcript shingles normalize case and punctuation and use distinct word five-grams', () => {
  assert.deepStrictEqual(transcriptShingles('One, TWO! Three? Four; Five. Six'),
    new Set(['one two three four five', 'two three four five six']));
  assert.deepStrictEqual(transcriptShingles('one one one one one one'), new Set(['one one one one one']));
  assert.deepStrictEqual(transcriptShingles('one two three', 2), new Set(['one two', 'two three']));
  assert.strictEqual(transcriptShingles(null).size, 0);
  assert.strictEqual(transcriptShingles('one two').size, 0);
  assert.strictEqual(transcriptShingles(words, 0).size, 0);
});

test('overlap uses the smaller shingle set and handles empty input', () => {
  assert.strictEqual(overlap(transcriptShingles(words), transcriptShingles(words.toUpperCase())), 1);
  assert.strictEqual(overlap(transcriptShingles(words), transcriptShingles(unrelated)), 0);
  assert.strictEqual(overlap(transcriptShingles(words), transcriptShingles('one two three four five six')), 1);
  assert.strictEqual(overlap(new Set(), transcriptShingles(words)), 0);
  assert.strictEqual(overlap(new Set(), new Set()), 0);
});

test('repeated audio matches same and different creators in both directions', () => {
  const matches = findRepeatedAudio([
    { id: 1, account_handle: 'one', ai_transcript: words },
    { id: 2, account_handle: 'one', ai_transcript: words.toUpperCase() },
    { id: 3, account_handle: 'two', ai_transcript: words },
    { id: 4, account_handle: 'two', ai_transcript: unrelated },
  ]);
  assert.deepStrictEqual([...matches], [
    [1, { matchId: 2, score: 1 }], [2, { matchId: 1, score: 1 }], [3, { matchId: 1, score: 1 }],
  ]);
});

test('short and missing transcripts never match and a reel cannot match itself', () => {
  assert.strictEqual(findRepeatedAudio([
    { id: 1, ai_transcript: 'one two three four five six seven eight nine ten eleven' },
    { id: 2, ai_transcript: 'one two three four five six seven eight nine ten eleven' },
    { id: 3, ai_transcript: null },
    { id: 4, ai_transcript: words },
    { id: 4, ai_transcript: words },
  ]).size, 0);
});

test('repeat threshold includes its boundary and selects the strongest match', () => {
  const rows = [
    { id: 1, ai_transcript: words },
    { id: 2, ai_transcript: 'one two three four five six seven eight nine ten eleven twelve apple banana cherry' },
    { id: 3, ai_transcript: words },
  ];
  const score = overlap(transcriptShingles(rows[0].ai_transcript), transcriptShingles(rows[1].ai_transcript));
  assert.deepStrictEqual(findRepeatedAudio(rows, { minOverlap: score }).get(2), { matchId: 1, score });
  assert.strictEqual(findRepeatedAudio(rows, { minOverlap: score + 0.01 }).has(2), false);
  assert.deepStrictEqual(findRepeatedAudio(rows).get(1), { matchId: 3, score: 1 });
});

test('confident lip sync becomes lipsync at the confidence boundary', () => {
  assert.deepStrictEqual(decideTalkingVsLipSync({ detector: { verdict: 'lip_sync', confidence: 0.7 } }),
    { sortStatus: 'auto', contentType: 'lipsync' });
});

test('confident live speech stays talking only without a repeat', () => {
  assert.deepStrictEqual(decideTalkingVsLipSync({ detector: { verdict: 'live_speech', confidence: 0.7 }, audioKind: 'other_voice' }),
    { sortStatus: 'auto', contentType: 'talking' });
  assert.deepStrictEqual(decideTalkingVsLipSync({ detector: { verdict: 'live_speech', confidence: 1 }, repeated: { matchId: 2, score: 1 } }),
    { sortStatus: 'needs_look', contentType: null, suggestedType: 'lipsync' });
});

test('repeat evidence becomes lipsync unless contradicted by confident live speech', () => {
  for (const detector of [undefined, { verdict: 'unsure', confidence: 1 }, { verdict: 'lip_sync', confidence: 0.2 }, { verdict: 'live_speech', confidence: 0.69 }]) {
    assert.deepStrictEqual(decideTalkingVsLipSync({ detector, repeated: { matchId: 2, score: 0.8 }, audioKind: 'own_speech' }),
      { sortStatus: 'auto', contentType: 'lipsync' });
  }
});

test('uncertain, low-confidence, missing and invalid detector results need a look', () => {
  for (const detector of [undefined, { verdict: 'unsure', confidence: 1 }, { verdict: 'lip_sync', confidence: 0.69 },
    { verdict: 'live_speech', confidence: 0.69 }, { verdict: 'other', confidence: 1 },
    { verdict: 'live_speech', confidence: NaN }, { verdict: 'live_speech', confidence: '1' }]) {
    assert.deepStrictEqual(decideTalkingVsLipSync({ detector, audioKind: 'own_speech' }),
      { sortStatus: 'needs_look', contentType: null, suggestedType: 'lipsync' });
  }
  assert.deepStrictEqual(decideTalkingVsLipSync({ detector: { verdict: 'lip_sync', confidence: 0.8 }, minConfidence: 0.9 }),
    { sortStatus: 'needs_look', contentType: null, suggestedType: 'lipsync' });
});

test('manual classification is untouched regardless of detector or repeat evidence', () => {
  assert.strictEqual(decideTalkingVsLipSync({ sortStatus: 'manual', detector: { verdict: 'lip_sync', confidence: 1 }, repeated: true }), null);
  assert.strictEqual(decideTalkingVsLipSync({ sortStatus: 'manual' }), null);
});
