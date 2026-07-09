const { test } = require('node:test');
const assert = require('node:assert');
const ContentIdeaAgent = require('./ai-agent');
const { IDEAS_SCHEMA } = ContentIdeaAgent;

// --- helpers -------------------------------------------------------------
function mockClient(response) {
  const calls = [];
  return { calls, messages: { create: async (params) => { calls.push(params); return response; } } };
}
function oneIdea(concept = 'Test concept') {
  return {
    concept,
    format: 'POV reel',
    why_working: 'Recurring hook pattern driving views',
    hook_line: 'Wait for it…',
    source_niche: 'fitness',
    source_posts: ['https://www.instagram.com/reel/abc/'],
  };
}
function happyResponse(ideas) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ ideas }) }] };
}
function samplePost() {
  return {
    account_handle: 'creator', niche: 'fitness', caption: 'great workout',
    view_count: 1000, like_count: 100, er_percent: 5,
    post_url: 'https://www.instagram.com/reel/abc/', shortcode: 'abc',
  };
}
function sampleModel() {
  return { name: 'TestModel', primary_niche: 'fitness', secondary_niches: '' };
}
function agentWith(response) {
  const agent = new ContentIdeaAgent('test-key'); // truthy key → this.client is created
  const mock = mockClient(response);
  agent.client = mock; // replace real client with the mock
  return { agent, mock };
}

// --- tests ---------------------------------------------------------------
test('_callClaude sends Opus 4.8 with adaptive thinking, structured output, and no temperature', async () => {
  const { agent, mock } = agentWith(happyResponse([oneIdea()]));
  await agent._callClaude([samplePost()], sampleModel(), []);
  const params = mock.calls[0];
  assert.strictEqual(params.model, 'claude-opus-4-8');
  assert.strictEqual(params.temperature, undefined);
  assert.strictEqual(params.thinking.type, 'adaptive');
  assert.strictEqual(params.output_config.effort, 'high');
  assert.strictEqual(params.output_config.format.type, 'json_schema');
  assert.deepStrictEqual(params.output_config.format.schema, IDEAS_SCHEMA);
  assert.strictEqual(params.max_tokens, 6000);
});

test('_callClaude parses structured ideas, caps at 5, and skips a leading thinking block', async () => {
  const six = Array.from({ length: 6 }, (_, i) => oneIdea(`concept ${i}`));
  const { agent } = agentWith({
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ ideas: six }) }],
  });
  const { ideas, warning } = await agent._callClaude([samplePost()], sampleModel(), []);
  assert.strictEqual(warning, null);
  assert.strictEqual(ideas.length, 5);
  assert.strictEqual(ideas[0].concept, 'concept 0');
});

test('_callClaude returns a warning (not a throw) on refusal', async () => {
  const { agent } = agentWith({ stop_reason: 'refusal', stop_details: { explanation: 'declined' }, content: [] });
  const { ideas, warning } = await agent._callClaude([samplePost()], sampleModel(), []);
  assert.deepStrictEqual(ideas, []);
  assert.ok(warning && warning.length > 0);
});

test('_callClaude returns a warning when there is no text block', async () => {
  const { agent } = agentWith({ stop_reason: 'end_turn', content: [] });
  const { ideas, warning } = await agent._callClaude([samplePost()], sampleModel(), []);
  assert.deepStrictEqual(ideas, []);
  assert.ok(warning);
});

test('_callClaude returns a warning on truncated/unparseable JSON without throwing', async () => {
  const { agent } = agentWith({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ideas":[{"concept":"x"' }] });
  const { ideas, warning } = await agent._callClaude([samplePost()], sampleModel(), []);
  assert.deepStrictEqual(ideas, []);
  assert.ok(warning);
  assert.ok(warning.includes('cut off'), 'truncated response warning mentions cut off');
});

test('_callClaude returns a warning containing the error message on SDK failure', async () => {
  const agent = new ContentIdeaAgent('test-key');
  agent.client = { messages: { create: async () => { throw new Error('network timeout'); } } };
  const { ideas, warning } = await agent._callClaude([samplePost()], sampleModel(), []);
  assert.deepStrictEqual(ideas, []);
  assert.ok(warning.includes('network timeout'));
});

test('personaBlock: empty when no character_context', () => {
  assert.strictEqual(ContentIdeaAgent.personaBlock({ name: 'X' }), '');
  assert.strictEqual(ContentIdeaAgent.personaBlock({ name: 'X', character_context: '' }), '');
});

test('personaBlock: includes the context when present', () => {
  const out = ContentIdeaAgent.personaBlock({ character_context: 'Flirty AZ party girl; never crude.' });
  assert.ok(out.includes('Flirty AZ party girl'));
  assert.match(out, /persona/i);
});
