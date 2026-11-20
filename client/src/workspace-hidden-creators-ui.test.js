import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import ModelWorkspace from './pages/ModelWorkspace';
import * as api from './api';

jest.mock('./api', () => ({
  getWorkspace: jest.fn(), getWorkspaceCreators: jest.fn(), getWorkspaceProposals: jest.fn(),
  getWorkspaceSuggestions: jest.fn(), getWorkspaceReels: jest.fn(), getWorkspaceTaste: jest.fn(),
  getContentTypes: jest.fn(), getLookTags: jest.fn(),
  getWorkspaceHiddenCreators: jest.fn(), hideWorkspaceCreators: jest.fn(), unhideWorkspaceCreator: jest.fn(),
}));

let container;
let root;
let hidden;
const reels = [
  { id: 1, account_handle: 'Alice', niche: 'talking' },
  { id: 2, account_handle: 'ALICE', niche: 'talking' },
  { id: 3, account_handle: 'bob', niche: 'talking' },
];
const section = () => container.querySelector('section[aria-labelledby="hidden-creators-title"]');
function button(text, scope = container) {
  return [...scope.querySelectorAll('button')].find(element => element.textContent.trim() === text);
}
async function click(element) {
  expect(element).toBeTruthy();
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}
async function render(modelId = 1) {
  await act(async () => { root.render(<ModelWorkspace modelId={modelId} />); });
}
async function submit(value) {
  await act(async () => { Simulate.change(section().querySelector('textarea'), { target: { value } }); });
  await act(async () => { Simulate.submit(section().querySelector('form')); });
}
function cardIds() {
  return [...container.querySelectorAll('article video')].map(video => Number(video.getAttribute('src').split('/').pop()));
}

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.resetAllMocks();
  hidden = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.getWorkspace.mockImplementation(async id => ({ data: { model: { id, name: id === 1 ? 'Destiny' : 'Mia' }, fallback: true } }));
  for (const method of ['getWorkspaceCreators', 'getWorkspaceProposals', 'getWorkspaceSuggestions', 'getContentTypes', 'getLookTags']) api[method].mockResolvedValue({ data: [] });
  api.getWorkspaceTaste.mockResolvedValue({ data: { liked: [], disliked: [] } });
  api.getWorkspaceHiddenCreators.mockImplementation(async () => ({ data: [...hidden] }));
  api.getWorkspaceReels.mockImplementation(async () => ({ data: reels.filter(reel => !hidden.some(item => item.username === reel.account_handle.toLowerCase())) }));
  api.hideWorkspaceCreators.mockImplementation(async (id, usernames) => {
    hidden = [...new Set([...hidden.map(item => item.username), ...usernames.map(value => value.replace(/^@/, '').toLowerCase())])].map(username => ({ username }));
    return { data: [...hidden] };
  });
  api.unhideWorkspaceCreator.mockImplementation(async (id, username) => {
    hidden = hidden.filter(item => item.username !== username);
    return { data: [...hidden] };
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
afterAll(() => { delete globalThis.IS_REACT_ACT_ENVIRONMENT; });

test('hidden section splits batches, lists normalized handles, and Unhide restores feed reels', async () => {
  await render();
  expect(section().textContent).toContain('No hidden creators.');
  expect(section().textContent).toContain('Destiny’s Find feed. Saved reels stay available.');
  await submit(' @Alice, bob\n@Carol  dave ');
  expect(api.hideWorkspaceCreators).toHaveBeenCalledWith(1, ['@Alice', 'bob', '@Carol', 'dave']);
  expect(section().querySelector('textarea').value).toBe('');
  expect([...section().querySelectorAll('li span')].map(span => span.textContent)).toEqual(['@alice', '@bob', '@carol', '@dave']);
  await click(button('Reels'));
  expect(cardIds()).toEqual([]);
  await click(section().querySelector('button[aria-label="Unhide @alice"]'));
  expect(api.unhideWorkspaceCreator).toHaveBeenCalledWith(1, 'alice');
  expect(cardIds()).toEqual([1, 2]);
});

test('reel Hide removes every reel by that creator and refreshes the hidden list', async () => {
  await render();
  await click(button('Reels'));
  expect(cardIds()).toEqual([1, 2, 3]);
  await click(container.querySelector('button[aria-label="Hide @Alice from feed"]'));
  expect(api.hideWorkspaceCreators).toHaveBeenCalledWith(1, ['Alice']);
  expect(cardIds()).toEqual([3]);
  expect(section().querySelector('li').textContent).toContain('@alice');
});

test('hide and unhide failures stay inline and preserve retryable input and list', async () => {
  hidden = [{ username: 'alice' }];
  await render();
  api.hideWorkspaceCreators.mockRejectedValueOnce({ response: { data: { error: 'Invalid username' } } });
  await submit('bad-handle');
  expect(section().querySelector('[role="alert"]').textContent).toBe('Invalid username');
  expect(section().querySelector('textarea').value).toBe('bad-handle');
  api.unhideWorkspaceCreator.mockRejectedValueOnce(new Error('Offline'));
  await click(button('Unhide', section()));
  expect(section().querySelector('[role="alert"]').textContent).toBe('Offline');
  expect(section().querySelector('li').textContent).toContain('@alice');
  await click(button('Unhide', section()));
  expect(section().querySelector('[role="alert"]')).toBeNull();
  expect(section().textContent).toContain('No hidden creators.');
});

test('saved hide stays reflected if reloading fails and duplicate pending actions are ignored', async () => {
  await render();
  await click(button('Reels'));
  let resolve;
  api.hideWorkspaceCreators.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const hide = container.querySelector('button[aria-label="Hide @Alice from feed"]');
  await act(async () => {
    hide.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    hide.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(api.hideWorkspaceCreators).toHaveBeenCalledTimes(1);
  expect(hide.disabled).toBe(true);
  api.getWorkspaceReels.mockRejectedValueOnce(new Error('Feed offline'));
  await act(async () => { resolve({ data: [{ username: 'alice' }] }); });
  expect(cardIds()).toEqual([3]);
  expect(section().textContent).toContain('@alice');
  expect(section().querySelector('[role="alert"]').textContent).toContain('Hidden list saved, but the workspace could not reload. Feed offline');
});

test('hidden handles render as plain text and model changes reset the section', async () => {
  hidden = [{ username: '<img src=x onerror=alert(1)>' }];
  await render();
  expect(section().querySelector('li span').textContent).toBe('@<img src=x onerror=alert(1)>');
  expect(section().querySelector('img')).toBeNull();
  hidden = [];
  await render(2);
  expect(section().textContent).toContain('Mia’s Find feed.');
  expect(section().textContent).toContain('No hidden creators.');
});
