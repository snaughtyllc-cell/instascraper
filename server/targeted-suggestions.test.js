const { test } = require('node:test');
const assert = require('node:assert');
const scraper = require('./scraper');

const {
  classifyGenderKeyword, parseGenderBatch, scoreCandidate, genderRank,
  aggregateCandidates, suggestionsOrderClause,
} = scraper;

test('classifyGenderKeyword: pronouns win over keywords', () => {
  assert.strictEqual(classifyGenderKeyword('jane', 'she/her | dancer'), 'female');
  assert.strictEqual(classifyGenderKeyword('mike', 'he/him'), 'male');
});

test('classifyGenderKeyword: keyword signals', () => {
  assert.strictEqual(classifyGenderKeyword('queenbee', 'lady boss'), 'female');
  assert.strictEqual(classifyGenderKeyword('thatguy', 'just a dad'), 'male');
});

test('classifyGenderKeyword: ambiguous/empty → unknown', () => {
  assert.strictEqual(classifyGenderKeyword('user123', ''), 'unknown');
  assert.strictEqual(classifyGenderKeyword('alex', 'creator | she and he collab'), 'unknown'); // both signals
});

test('parseGenderBatch: maps verdicts, defaults missing to unknown', () => {
  const text = '{"verdicts":[{"username":"Aimee","gender":"female"},{"username":"bob","gender":"male"}]}';
  const out = parseGenderBatch(text, ['aimee', 'bob', 'casey']);
  assert.strictEqual(out.aimee, 'female');
  assert.strictEqual(out.bob, 'male');
  assert.strictEqual(out.casey, 'unknown'); // not in response
});

test('parseGenderBatch: tolerates junk/empty without throwing', () => {
  assert.deepStrictEqual(parseGenderBatch('not json', ['x']), { x: 'unknown' });
  assert.deepStrictEqual(parseGenderBatch('', ['x']), { x: 'unknown' });
  assert.deepStrictEqual(parseGenderBatch(null, ['x']), { x: 'unknown' });
});

test('scoreCandidate: collab strength, ER, frequency combine and cap', () => {
  assert.strictEqual(scoreCandidate({ collabStrength: 3, avgEr: 6, postsPerWeek: 5 }), 100);
  assert.strictEqual(scoreCandidate({ collabStrength: 1, avgEr: 0, postsPerWeek: 0 }), 17); // 50/3 rounded
  assert.ok(scoreCandidate({ collabStrength: 9, avgEr: 99, postsPerWeek: 99 }) === 100); // capped
});

test('genderRank: female ranks above everything else', () => {
  assert.strictEqual(genderRank('female'), 0);
  assert.strictEqual(genderRank('unknown'), 1);
  assert.strictEqual(genderRank('male'), 1);
});

test('aggregateCandidates: merges by username, counts distinct sources', () => {
  const merged = aggregateCandidates([
    { username: 'aimee', sourceAccount: 'creatorA', avgEr: 3, gender: 'female' },
    { username: 'Aimee', sourceAccount: 'creatorB', avgEr: 5, gender: 'unknown' },
    { username: 'bob', sourceAccount: 'creatorA', avgEr: 1, gender: 'male' },
  ]);
  const aimee = merged.find(c => c.username.toLowerCase() === 'aimee');
  assert.strictEqual(aimee.collabStrength, 2);
  assert.strictEqual(aimee.avgEr, 5);            // max kept
  assert.strictEqual(aimee.gender, 'female');    // confident verdict kept over unknown
  assert.match(aimee.relevanceReason, /2 of your creators/);
  const bob = merged.find(c => c.username.toLowerCase() === 'bob');
  assert.strictEqual(bob.collabStrength, 1);
});

test('suggestionsOrderClause: female-first, then the chosen sort', () => {
  assert.match(suggestionsOrderClause('score'), /gender = 'female'/);
  assert.match(suggestionsOrderClause('score'), /suggestion_score DESC/);
  assert.match(suggestionsOrderClause('er'), /avg_er DESC/);
  assert.match(suggestionsOrderClause('bogus'), /suggestion_score DESC/); // fallback
});
