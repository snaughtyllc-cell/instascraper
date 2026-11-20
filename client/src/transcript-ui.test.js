import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ContentCard from './components/ContentCard';
import Transcript from './components/Transcript';
import ModelWorkspace from './pages/ModelWorkspace';
import * as api from './api';

jest.mock('./api', () => ({
  saveNotes: jest.fn(), archivePost: jest.fn(), setPostContentType: jest.fn(),
  getWorkspace: jest.fn(), getWorkspaceCreators: jest.fn(), getWorkspaceProposals: jest.fn(),
  getWorkspaceSuggestions: jest.fn(), getWorkspaceReels: jest.fn(), getWorkspaceTaste: jest.fn(),
  getContentTypes: jest.fn(), getLookTags: jest.fn(),
  getWorkspaceHiddenCreators: jest.fn(),
}));

const transcript = 'Estas son mis palabras.\nSin traducción.';
let container;
let root;
let writeText;

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  writeText = jest.fn().mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  delete navigator.clipboard;
});
afterAll(() => { delete globalThis.IS_REACT_ACT_ENVIRONMENT; });

async function render(element) { await act(async () => { root.render(element); }); }
async function click(element) {
  expect(element).toBeTruthy();
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

test('reel card transcript starts collapsed and copies the original text', async () => {
  await render(<ContentCard post={{ id: 1, shortcode: 'reel', account_handle: 'creator', ai_transcript: transcript }} />);
  const details = container.querySelector('details');
  expect(details.open).toBe(false);
  expect(details.querySelector('summary').textContent).toBe('Transcript');
  expect(details.querySelector('p').textContent).toBe(transcript);
  await click(details.querySelector('summary'));
  expect(details.open).toBe(true);
  await click(details.querySelector('button[aria-label="Copy transcript"]'));
  expect(writeText).toHaveBeenCalledWith(transcript);
  expect(details.querySelector('[role="status"]').textContent).toBe('Copied');
});

test('transcript hides empty sentinels and reports clipboard failures', async () => {
  await render(<Transcript transcript="" />);
  expect(container.querySelector('details')).toBeNull();
  await render(<Transcript transcript={null} />);
  expect(container.querySelector('details')).toBeNull();
  writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'));
  await render(<Transcript transcript={transcript} />);
  await click(container.querySelector('button'));
  expect(container.querySelector('[role="status"]').textContent).toContain('Could not copy');
});

test('workspace Reels view includes collapsed transcripts and copy controls', async () => {
  api.getWorkspace.mockResolvedValue({ data: { model: { id: 1, name: 'Logan', primary_niche: 'talking' } } });
  for (const method of ['getWorkspaceCreators', 'getWorkspaceProposals', 'getWorkspaceSuggestions', 'getContentTypes', 'getLookTags', 'getWorkspaceHiddenCreators']) api[method].mockResolvedValue({ data: [] });
  api.getWorkspaceTaste.mockResolvedValue({ data: { liked: [], disliked: [] } });
  api.getWorkspaceReels.mockResolvedValue({ data: [{ id: 1, account_handle: 'creator', niche: 'talking', ai_transcript: transcript }] });
  await render(<ModelWorkspace modelId={1} onBack={jest.fn()} onEdit={jest.fn()} />);
  await click([...container.querySelectorAll('button')].find(button => button.textContent === 'Reels'));
  const details = container.querySelector('article details');
  expect(details.open).toBe(false);
  await click(details.querySelector('summary'));
  expect(details.open).toBe(true);
  await click(details.querySelector('button'));
  expect(writeText).toHaveBeenCalledWith(transcript);
});
