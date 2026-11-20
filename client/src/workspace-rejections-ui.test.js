import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ModelWorkspace from './pages/ModelWorkspace';
import * as api from './api';

jest.mock('./api', () => ({
  getWorkspace: jest.fn(), getWorkspaceCreators: jest.fn(), getWorkspaceProposals: jest.fn(),
  getWorkspaceSuggestions: jest.fn(), getWorkspaceReels: jest.fn(), getWorkspaceTaste: jest.fn(),
  getContentTypes: jest.fn(), getLookTags: jest.fn(),
  getWorkspaceHiddenCreators: jest.fn(),
  rejectWorkspaceReel: jest.fn(), undoWorkspaceReelRejection: jest.fn(),
  confirmWorkspaceProposal: jest.fn(),
}));

let container;
let root;
let rows;
let originals;
const reel = id => ({ id, account_handle: `creator-${id}`, niche: 'talking' });
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function button(text, scope = container) {
  return [...scope.querySelectorAll('button')].find(element => element.textContent.trim() === text);
}
async function click(element) {
  expect(element).toBeTruthy();
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}
async function render(modelId = 1) {
  await act(async () => { root.render(<ModelWorkspace modelId={modelId} onBack={jest.fn()} onEdit={jest.fn()} />); });
}
function cardIds() {
  return [...container.querySelectorAll('article video')].map(video => Number(video.getAttribute('src').split('/').pop()));
}
async function openReels(count = 1) {
  originals = Array.from({ length: count }, (_, index) => reel(index + 1));
  rows = [...originals];
  await render();
  await click(button('Reels'));
}

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  rows = [];
  originals = [];
  api.getWorkspace.mockImplementation(async id => ({ data: { model: { id, name: id === 1 ? 'Logan' : 'Mia', primary_niche: 'talking' } } }));
  for (const method of ['getWorkspaceCreators', 'getWorkspaceProposals', 'getWorkspaceSuggestions', 'getContentTypes', 'getLookTags', 'getWorkspaceHiddenCreators']) api[method].mockResolvedValue({ data: [] });
  api.getWorkspaceTaste.mockResolvedValue({ data: { liked: [], disliked: [] } });
  api.getWorkspaceReels.mockImplementation(async (id, page = 1) => ({ data: rows.slice((page - 1) * 24, page * 24) }));
  api.rejectWorkspaceReel.mockImplementation(async (id, postId) => {
    rows = rows.filter(item => item.id !== postId);
    return { data: { feedback: 'not_my_style' } };
  });
  api.undoWorkspaceReelRejection.mockImplementation(async (id, postId) => {
    if (!rows.some(item => item.id === postId)) rows = [...rows, originals.find(item => item.id === postId)].sort((a, b) => a.id - b.id);
    return { data: { success: true } };
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
afterAll(() => { delete globalThis.IS_REACT_ACT_ENVIRONMENT; });

test('reject removes the reel, names the model, refreshes taste, and Undo restores it', async () => {
  await openReels();
  await click(button('Not a good pick'));
  expect(api.rejectWorkspaceReel).toHaveBeenCalledWith(1, 1);
  expect(cardIds()).toEqual([]);
  expect(container.querySelector('[role="status"]').textContent).toContain('Removed from Logan’s feed · Undo');
  expect(api.getWorkspaceTaste).toHaveBeenCalledTimes(2);
  await click(button('Undo'));
  expect(api.undoWorkspaceReelRejection).toHaveBeenCalledWith(1, 1);
  expect(cardIds()).toEqual([1]);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

test('pending actions reject duplicate clicks and failures remain inline with retryable Undo', async () => {
  await openReels();
  const rejection = deferred();
  api.rejectWorkspaceReel.mockReturnValueOnce(rejection.promise);
  const rejectButton = button('Not a good pick');
  await act(async () => {
    rejectButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    rejectButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(api.rejectWorkspaceReel).toHaveBeenCalledTimes(1);
  expect(button('Removing…').disabled).toBe(true);
  await act(async () => { rejection.reject(new Error('Offline')); });
  expect(cardIds()).toEqual([1]);
  expect(container.querySelector('article [role="alert"]').textContent).toContain('Could not remove this reel. Try again. Offline');
  await click(button('Not a good pick'));
  const undo = deferred();
  api.undoWorkspaceReelRejection.mockReturnValueOnce(undo.promise);
  const undoButton = button('Undo');
  await act(async () => {
    undoButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    undoButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(api.undoWorkspaceReelRejection).toHaveBeenCalledTimes(1);
  expect(button('Undoing…').disabled).toBe(true);
  await act(async () => { undo.reject(new Error('Try later')); });
  expect(container.querySelector('[role="alert"]').textContent).toContain('Could not restore this reel. Try Undo again. Try later');
  expect(button('Undo').disabled).toBe(false);
  await click(button('Undo'));
  expect(cardIds()).toEqual([1]);
});

test('rejection reloads every loaded page before pagination advances after taste reranks reels', async () => {
  await openReels(50);
  await click(button('Load more reels'));
  expect(cardIds()).toHaveLength(48);
  api.rejectWorkspaceReel.mockImplementationOnce(async (id, postId) => {
    rows = [rows[49], ...rows.filter(item => item.id !== postId && item.id !== 50)];
    return { data: { feedback: 'not_my_style' } };
  });
  await click(button('Not a good pick'));
  expect(api.getWorkspaceReels.mock.calls.slice(-2)).toEqual([[1, 1], [1, 2]]);
  expect(cardIds()[0]).toBe(50);
  await click(button('Load more reels'));
  expect(cardIds().slice().sort((a, b) => a - b)).toEqual(originals.slice(1).map(item => item.id));
  await click(button('Undo'));
  expect(cardIds()).toEqual(originals.map(item => item.id));
});

test('failed revalidation keeps pagination safe and successful Undo can retry a failed feed reload', async () => {
  await openReels(26);
  api.getWorkspaceReels.mockRejectedValueOnce(new Error('Reload unavailable'));
  await click(button('Not a good pick'));
  expect(cardIds()).toHaveLength(23);
  expect(container.querySelector('[role="alert"]').textContent).toContain('Reel removed, but the feed could not reload');
  await click(button('Load more reels'));
  expect(api.getWorkspaceReels.mock.calls.slice(-2)).toEqual([[1, 1], [1, 2]]);
  expect(cardIds().slice().sort((a, b) => a - b)).toEqual(originals.slice(1).map(item => item.id));
  api.getWorkspaceReels.mockRejectedValueOnce(new Error('Reload unavailable'));
  await click(button('Undo'));
  expect(container.textContent).toContain('Undo saved, but the feed could not reload. Try Undo again.');
  expect(button('Undo').disabled).toBe(false);
  await click(button('Undo'));
  expect(cardIds()).toEqual(originals.map(item => item.id));
});

test('Undo trusts the feed when a newer save or assignment keeps the reel hidden', async () => {
  await openReels();
  await click(button('Not a good pick'));
  api.undoWorkspaceReelRejection.mockResolvedValueOnce({ data: { success: true } });
  await click(button('Undo'));
  expect(cardIds()).toEqual([]);
  expect(button('Undo')).toBeUndefined();
});

test('pagination recovers a failed Undo reload and the same card can be rejected again once', async () => {
  await openReels(50);
  await click(button('Not a good pick'));
  api.getWorkspaceReels.mockRejectedValueOnce(new Error('Reload unavailable'));
  await click(button('Undo'));
  expect(container.textContent).toContain('Undo saved, but the feed could not reload');
  rows = [rows[49], ...rows.filter(item => item.id !== 50)];
  await click(button('Load more reels'));
  expect(cardIds()).toEqual(rows.slice(0, 48).map(item => item.id));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(button('Undo')).toBeUndefined();
  const restored = [...container.querySelectorAll('article')].find(article => article.textContent.includes('@creator-1'));
  await click(button('Not a good pick', restored));
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(cardIds()).not.toContain(1);
});

test('a creator action reconciles a restored card and clears a failed Undo notice', async () => {
  api.getWorkspaceProposals.mockResolvedValue({ data: [{ username: 'proposed', share: 1 }] });
  api.confirmWorkspaceProposal.mockResolvedValue({ data: { success: true } });
  await openReels();
  await click(button('Not a good pick'));
  api.getWorkspaceReels.mockRejectedValueOnce(new Error('Reload unavailable'));
  await click(button('Undo'));
  expect(container.textContent).toContain('Undo saved, but the feed could not reload');
  await click(button('Creators (0)'));
  await click(button('Confirm'));
  expect(api.confirmWorkspaceProposal).toHaveBeenCalledWith(1, 'proposed');
  await click(button('Reels'));
  expect(cardIds()).toEqual([1]);
  expect(button('Undo')).toBeUndefined();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test('switching models ignores a late rejection result and resets the pending state', async () => {
  await openReels();
  const rejection = deferred();
  api.rejectWorkspaceReel.mockReturnValueOnce(rejection.promise);
  await click(button('Not a good pick'));
  rows = [reel(201)];
  await render(2);
  await click(button('Reels'));
  await act(async () => { rejection.resolve({ data: { feedback: 'not_my_style' } }); });
  expect(container.querySelector('header').textContent).toContain('Mia');
  expect(cardIds()).toEqual([201]);
  expect(button('Not a good pick').disabled).toBe(false);
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(api.getWorkspaceReels.mock.calls.filter(([id]) => id === 1)).toHaveLength(1);
});
