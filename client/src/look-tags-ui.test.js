import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { LookTagPicker } from './components/LookTags';
import AdminCockpitTab from './pages/AdminCockpitTab';
import ModelWorkspace from './pages/ModelWorkspace';
import * as api from './api';

jest.mock('./api', () => ({
  getModelCockpit: jest.fn(), getSortUsage: jest.fn(), getLookTags: jest.fn(),
  getLookBackfillEstimate: jest.fn(), startLookBackfill: jest.fn(),
  getTranscriptBackfillEstimate: jest.fn(), startTranscriptBackfill: jest.fn(),
  getTalkingRecheckEstimate: jest.fn(), startTalkingRecheck: jest.fn(),
  addLookTag: jest.fn(), deleteLookTag: jest.fn(),
  getWorkspace: jest.fn(), getWorkspaceCreators: jest.fn(), getWorkspaceProposals: jest.fn(),
  getWorkspaceSuggestions: jest.fn(), getWorkspaceReels: jest.fn(), getWorkspaceTaste: jest.fn(),
  getContentTypes: jest.fn(), addContentType: jest.fn(), updateContentType: jest.fn(), addCreatorLookTag: jest.fn(), removeCreatorLookTag: jest.fn(),
}));

const vocabulary = [
  { id: 1, value: 'brunette', label: 'Brunette', category: 'hair' },
  { id: 2, value: 'emo', label: 'Emo', category: 'aesthetic' },
  { id: 3, value: 'bedroom', label: 'Bedroom', category: 'setting' },
  { id: 4, value: 'team-custom', label: 'Team custom', category: 'custom' },
];
let container;
let root;

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.getLookTags.mockResolvedValue({ data: vocabulary });
  api.getModelCockpit.mockResolvedValue({ data: { summary: {}, models: [], actionQueue: [], recent: [] } });
  api.getSortUsage.mockResolvedValue({ data: { reels30d: 0, usd30d: 0, today: 0, dailyMax: 10 } });
  api.getLookBackfillEstimate.mockResolvedValue({ data: { count: 8, estUsd: 0.01016 } });
  api.startLookBackfill.mockResolvedValue({ data: { started: true } });
  api.getTranscriptBackfillEstimate.mockResolvedValue({ data: { count: 4, estUsd: 0.02008 } });
  api.startTranscriptBackfill.mockResolvedValue({ data: { started: true } });
  api.getTalkingRecheckEstimate.mockResolvedValue({ data: { count: 6, estUsd: 0.03012 } });
  api.startTalkingRecheck.mockResolvedValue({ data: { started: true } });
  api.getContentTypes.mockResolvedValue({ data: [{ id: 1, value: 'talking', label: 'Talking', description: 'Their own live speech.' }] });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  jest.restoreAllMocks();
});
afterAll(() => { delete globalThis.IS_REACT_ACT_ENVIRONMENT; });

async function render(element) { await act(async () => { root.render(element); }); }
async function click(element) {
  expect(element).toBeTruthy();
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}
function button(text, scope = container) {
  return [...scope.querySelectorAll('button')].find(element => element.textContent.trim() === text);
}
async function change(element, value) {
  await act(async () => { Simulate.change(element, { target: { value } }); });
}
function lookCard() { return container.querySelector('section[aria-labelledby="look-tags-title"]'); }

test('look picker groups the vocabulary and toggles selected tags', async () => {
  const onChange = jest.fn();
  function Picker() {
    const [selected, setSelected] = useState(['brunette']);
    return <LookTagPicker vocabulary={vocabulary} selected={selected} onChange={values => { setSelected(values); onChange(values); }} />;
  }
  await render(<Picker />);
  const fieldset = container.querySelector('fieldset');
  expect(fieldset.querySelector('legend').textContent).toBe('Look tags');
  for (const category of ['hair', 'aesthetic', 'setting', 'custom']) expect(fieldset.textContent).toContain(category);
  expect(button('Brunette').getAttribute('aria-pressed')).toBe('true');
  await click(button('Bedroom'));
  expect(onChange).toHaveBeenLastCalledWith(['brunette', 'bedroom']);
  expect(button('Bedroom').getAttribute('aria-pressed')).toBe('true');
  await click(button('Brunette'));
  expect(onChange).toHaveBeenLastCalledWith(['bedroom']);
  expect(button('Brunette').getAttribute('aria-pressed')).toBe('false');
  await click(button('Team custom'));
  expect(onChange).toHaveBeenLastCalledWith(['bedroom', 'team-custom']);
});

test('cockpit shows the estimate and cancelling confirmation never starts tagging', async () => {
  api.getLookBackfillEstimate.mockResolvedValueOnce({ data: { count: 8, estUsd: 0.01016 } })
    .mockResolvedValue({ data: { count: 5, estUsd: 0.00635 } });
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
  await render(<AdminCockpitTab />);
  expect(lookCard().textContent).toContain('8 eligible reels');
  expect(lookCard().textContent).toContain('$0.0102');
  await click(button('Tag existing reels', lookCard()));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][0]).toContain('Tag 5 existing reels');
  expect(confirm.mock.calls[0][0]).toContain('$0.0064');
  expect(api.startLookBackfill).not.toHaveBeenCalled();
});

test('cockpit starts tagging after confirmation and reports it', async () => {
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  await render(<AdminCockpitTab />);
  await click(button('Tag existing reels', lookCard()));
  expect(api.startLookBackfill).toHaveBeenCalledTimes(1);
  expect(lookCard().querySelector('[role="status"]').textContent).toContain('Look tagging started');
});

test('cockpit adds and deletes vocabulary tags through the form', async () => {
  let tags = [...vocabulary];
  api.getLookTags.mockImplementation(async () => ({ data: [...tags] }));
  api.addLookTag.mockImplementation(async (label, category) => {
    tags.push({ id: 5, value: 'soft-glam', label, category });
    return { data: tags[tags.length - 1] };
  });
  api.deleteLookTag.mockImplementation(async id => { tags = tags.filter(tag => tag.id !== id); return { data: { ok: true } }; });
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  await render(<AdminCockpitTab />);
  await change(lookCard().querySelector('input'), 'Soft glam');
  await change(lookCard().querySelector('select'), 'custom');
  await act(async () => { Simulate.submit(lookCard().querySelector('form')); });
  expect(api.addLookTag).toHaveBeenCalledWith('Soft glam', 'custom');
  expect(lookCard().textContent).toContain('Soft glam');
  expect(lookCard().querySelector('input').value).toBe('');
  await click(lookCard().querySelector('button[aria-label="Delete Soft glam tag"]'));
  expect(api.deleteLookTag).toHaveBeenCalledWith(5);
  expect(lookCard().textContent).not.toContain('Soft glam');
});

test('cockpit confirms the refreshed transcript estimate and cancellation does not start work', async () => {
  api.getTranscriptBackfillEstimate.mockResolvedValueOnce({ data: { count: 4, estUsd: 0.02008 } })
    .mockResolvedValue({ data: { count: 3, estUsd: 0.01506 } });
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
  await render(<AdminCockpitTab />);
  const card = container.querySelector('section[aria-labelledby="transcripts-title"]');
  expect(card.textContent).toContain('4 eligible reels');
  expect(card.textContent).toContain('$0.0201');
  await click(button('Transcribe existing talking reels', card));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][0]).toContain('Transcribe 3 existing talking reels');
  expect(confirm.mock.calls[0][0]).toContain('$0.0151');
  expect(confirm.mock.calls[0][0]).toContain('shared daily AI cap');
  expect(api.startTranscriptBackfill).not.toHaveBeenCalled();
});

test('cockpit starts transcript backfill only after confirmation', async () => {
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  await render(<AdminCockpitTab />);
  const card = container.querySelector('section[aria-labelledby="transcripts-title"]');
  await click(button('Transcribe existing talking reels', card));
  expect(api.startTranscriptBackfill).toHaveBeenCalledTimes(1);
  expect(card.querySelector('[role="status"]').textContent).toContain('Transcription started');
});

test('cockpit skips transcript backfill when the refreshed estimate is empty', async () => {
  api.getTranscriptBackfillEstimate.mockResolvedValue({ data: { count: 0, estUsd: 0 } });
  const confirm = jest.spyOn(window, 'confirm');
  await render(<AdminCockpitTab />);
  const card = container.querySelector('section[aria-labelledby="transcripts-title"]');
  await click(button('Transcribe existing talking reels', card));
  expect(confirm).not.toHaveBeenCalled();
  expect(api.startTranscriptBackfill).not.toHaveBeenCalled();
  expect(card.querySelector('[role="status"]').textContent).toContain('No cached talking reels');
});

test('talking recheck refreshes the estimate and cancellation never starts work', async () => {
  api.getTalkingRecheckEstimate.mockResolvedValueOnce({ data: { count: 6, estUsd: 0.03012 } })
    .mockResolvedValue({ data: { count: 3, estUsd: 0.01506 } });
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
  await render(<AdminCockpitTab />);
  const card = container.querySelector('section[aria-labelledby="talking-recheck-title"]');
  expect(card.textContent).toContain('6 eligible reels');
  await click(button('Re-check talking reels', card));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][0]).toContain('Re-check 3 auto-sorted talking reels');
  expect(confirm.mock.calls[0][0]).toContain('$0.0151');
  expect(confirm.mock.calls[0][0]).toContain('Manual reels stay unchanged');
  expect(api.startTalkingRecheck).not.toHaveBeenCalled();
});

test('talking recheck confirms and sends the selected model priority', async () => {
  api.getModelCockpit.mockResolvedValue({ data: { models: [{ id: 7, name: 'Logan' }] } });
  api.getTalkingRecheckEstimate.mockResolvedValue({ data: { count: 6, estUsd: 0.03012, priorityCount: 2 } });
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  await render(<AdminCockpitTab />);
  const card = container.querySelector('section[aria-labelledby="talking-recheck-title"]');
  await change(card.querySelector('select'), '7');
  expect(api.getTalkingRecheckEstimate).toHaveBeenLastCalledWith('7');
  expect(card.textContent).toContain('2 from this workspace');
  await click(button('Re-check talking reels', card));
  expect(api.startTalkingRecheck).toHaveBeenCalledWith('7');
  expect(card.querySelector('[role="status"]').textContent).toContain('Talking re-check started');
});

test('talking recheck skips confirmation when no reels remain', async () => {
  api.getTalkingRecheckEstimate.mockResolvedValue({ data: { count: 0, estUsd: 0 } });
  const confirm = jest.spyOn(window, 'confirm');
  await render(<AdminCockpitTab />);
  const card = container.querySelector('section[aria-labelledby="talking-recheck-title"]');
  await click(button('Re-check talking reels', card));
  expect(confirm).not.toHaveBeenCalled();
  expect(api.startTalkingRecheck).not.toHaveBeenCalled();
  expect(card.querySelector('[role="status"]').textContent).toContain('No auto-sorted talking reels');
});

test('content types manager shows definitions and saves edits and new types', async () => {
  const types = [{ id: 1, value: 'talking', label: 'Talking', description: 'Their own live speech.' }];
  api.getContentTypes.mockImplementation(async () => ({ data: [...types] }));
  api.updateContentType.mockImplementation(async (id, fields) => {
    Object.assign(types.find(type => type.id === id), fields);
    return { data: types.find(type => type.id === id) };
  });
  api.addContentType.mockImplementation(async (label, description) => {
    const type = { id: 2, value: 'lipsync', label, description };
    types.push(type);
    return { data: type };
  });
  await render(<AdminCockpitTab />);
  const card = container.querySelector('section[aria-labelledby="content-types-title"]');
  expect(card.textContent).toContain('Their own live speech.');
  await click(card.querySelector('button[aria-label="Edit Talking content type"]'));
  await change(card.querySelector('input'), 'Speaking');
  await change(card.querySelector('textarea'), 'The speaker uses their own voice.');
  await act(async () => { Simulate.submit(card.querySelector('form')); });
  expect(api.updateContentType).toHaveBeenCalledWith(1, { label: 'Speaking', description: 'The speaker uses their own voice.' });
  expect(card.textContent).toContain('The speaker uses their own voice.');
  expect(card.textContent).toContain('talking');
  await change(card.querySelector('input'), 'Lip sync');
  await change(card.querySelector('textarea'), 'Mouthing someone else’s recorded audio.');
  await act(async () => { Simulate.submit(card.querySelector('form')); });
  expect(api.addContentType).toHaveBeenCalledWith('Lip sync', 'Mouthing someone else’s recorded audio.');
  expect(card.textContent).toContain('Mouthing someone else’s recorded audio.');
  expect(card.querySelector('textarea').value).toBe('');
});

test('workspace shows parsed looks, creator shares, manual tags, taste and edit action', async () => {
  const model = { id: 1, name: 'Logan', primary_niche: 'talking', look_tags: '["brunette","bedroom"]' };
  let look = [{ tag: 'brunette', share: 0.5, manual: false }];
  api.getWorkspace.mockResolvedValue({ data: { model, fallback: false } });
  api.getWorkspaceCreators.mockImplementation(async () => ({ data: [{ username: 'creator', mix: [{ type: 'talking', pct: 100 }], look, status: 'active' }] }));
  api.getWorkspaceProposals.mockResolvedValue({ data: [{ username: 'proposed', share: 0.5, look_match: 0.6 }] });
  api.getWorkspaceSuggestions.mockResolvedValue({ data: [{ username: 'suggested', fit: 0.8, look_match: 0.75, top_reels: [] }] });
  api.getWorkspaceReels.mockResolvedValue({ data: [] });
  api.getWorkspaceTaste.mockResolvedValue({ data: {
    liked: [{ feature: 'type:talking', affinity: 0.5 }],
    disliked: [{ feature: 'creator:other', affinity: -1 / 3 }],
  } });
  api.getContentTypes.mockResolvedValue({ data: [{ value: 'talking', label: 'Talking' }] });
  api.addCreatorLookTag.mockImplementation(async (username, tag) => {
    look = [...look, { tag, share: 1, manual: true }];
    return { data: { ok: true } };
  });
  const onEdit = jest.fn();
  await render(<ModelWorkspace modelId={1} onBack={jest.fn()} onEdit={onEdit} />);
  expect(container.querySelector('header').textContent).toContain('Brunette');
  expect(container.querySelector('header').textContent).toContain('Bedroom');
  expect(container.textContent).toContain('Brunette 50%');
  const taste = container.querySelector('section[aria-labelledby="model-taste-title"]');
  for (const text of ['Talking', '+0.50', '@other', '-0.33']) expect(taste.textContent).toContain(text);
  expect(container.textContent).toContain('Look match 60%');
  await click(button('Edit look'));
  expect(onEdit).toHaveBeenCalledWith(model);
  const picker = container.querySelector('select[aria-label="Add look tag to @creator"]');
  expect([...picker.querySelectorAll('optgroup[label="custom"] option')].map(option => option.value)).toContain('team-custom');
  await change(picker, 'team-custom');
  expect(api.addCreatorLookTag).toHaveBeenCalledWith('creator', 'team-custom');
  expect(container.textContent).toContain('Team custom 100%');
  expect(container.querySelector('button[aria-label="Remove manual Team custom tag"]')).toBeTruthy();
  await click(button('Suggested (1)'));
  expect(container.textContent).toContain('Look match 75%');
});
