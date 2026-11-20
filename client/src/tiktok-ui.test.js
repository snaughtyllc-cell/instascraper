import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import ContentCard from './components/ContentCard';
import ReelCard from './components/ReelCard';
import IdeaReel from './components/IdeaReel';
import ModelWorkspace from './pages/ModelWorkspace';
import TrackedAccountsTab from './pages/TrackedAccountsTab';
import ScrapeTab from './pages/ScrapeTab';
import AudioTab from './pages/AudioTab';
import DeleteLogTab from './pages/DeleteLogTab';
import EngagementTab from './pages/EngagementTab';
import SoundsPage from './pages/model/SoundsPage';
import * as api from './api';

jest.mock('@sentry/react', () => ({ captureMessage: jest.fn() }));

jest.mock('./api', () => ({
  saveNotes: jest.fn(), archivePost: jest.fn(), setPostContentType: jest.fn(),
  getWorkspace: jest.fn(), getWorkspaceCreators: jest.fn(), getWorkspaceProposals: jest.fn(),
  getWorkspaceSuggestions: jest.fn(), getWorkspaceReels: jest.fn(), getWorkspaceTaste: jest.fn(),
  getContentTypes: jest.fn(), getLookTags: jest.fn(), addWorkspaceCreator: jest.fn(),
  getWorkspaceHiddenCreators: jest.fn(),
  getTrackedAccounts: jest.fn(), getCreators: jest.fn(), getSchedulerStatus: jest.fn(),
  getTrendingAudio: jest.fn(), getMyTrendingAudio: jest.fn(),
  triggerScrape: jest.fn(), getScrapeJobs: jest.fn(),
  getDeleteLog: jest.fn(), getEngagementLeaderboard: jest.fn(), getEngagementSummary: jest.fn(),
}));

let container;
let root;

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.getWorkspace.mockResolvedValue({ data: { model: { id: 9, name: 'Destiny' } } });
  for (const method of ['getWorkspaceCreators', 'getWorkspaceProposals', 'getWorkspaceSuggestions', 'getWorkspaceReels', 'getContentTypes', 'getLookTags', 'getTrackedAccounts', 'getCreators', 'getScrapeJobs', 'getWorkspaceHiddenCreators']) api[method].mockResolvedValue({ data: [] });
  api.getWorkspaceTaste.mockResolvedValue({ data: { liked: [], disliked: [] } });
  api.addWorkspaceCreator.mockResolvedValue({ data: {} });
  api.triggerScrape.mockResolvedValue({ data: {} });
  api.getSchedulerStatus.mockResolvedValue({ data: null });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
afterAll(() => { delete globalThis.IS_REACT_ACT_ENVIRONMENT; });

async function render(element) { await act(async () => { root.render(element); }); }
async function change(element, value) { await act(async () => { Simulate.change(element, { target: { value } }); }); }
async function click(element) { await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); }
async function submit(form = container.querySelector('form')) { await act(async () => { Simulate.submit(form); }); }
function button(text) { return [...container.querySelectorAll('button')].find(element => element.textContent.trim() === text); }

test('workspace defaults to Instagram and allows a TikTok handle or pasted URL', async () => {
  await render(<ModelWorkspace modelId={9} />);
  const username = container.querySelector('input[aria-label="Add creator username"]');
  expect(button('Instagram').getAttribute('aria-pressed')).toBe('true');
  await change(username, '@instagram_creator');
  await submit(username.closest('form'));
  expect(api.addWorkspaceCreator).toHaveBeenLastCalledWith(9, '@instagram_creator', 'instagram');
  await click(button('TikTok'));
  await change(username, '@tiktok_creator');
  await submit(username.closest('form'));
  expect(api.addWorkspaceCreator).toHaveBeenLastCalledWith(9, '@tiktok_creator', 'tiktok');
  await click(button('Instagram'));
  for (const host of ['www.tiktok.com', 'm.tiktok.com']) {
    await click(button('Instagram'));
    const url = `https://${host}/@pardisscarelllo/video/123?lang=en`;
    await change(username, url);
    expect(button('TikTok').getAttribute('aria-pressed')).toBe('true');
    await submit(username.closest('form'));
    expect(api.addWorkspaceCreator).toHaveBeenLastCalledWith(9, url, 'tiktok');
  }
});

test('workspace and tracked creators link to the right platform and badge TikTok', async () => {
  api.getWorkspaceCreators.mockResolvedValue({ data: [
    { username: 'tiktok_creator', platform: 'tiktok', mix: [] },
    { username: 'instagram_creator', mix: [] },
  ] });
  await render(<ModelWorkspace modelId={9} />);
  expect(container.querySelector('a[href="https://www.tiktok.com/@tiktok_creator"]')).toBeTruthy();
  expect(container.querySelector('a[href="https://instagram.com/instagram_creator"]')).toBeTruthy();
  expect(container.querySelector('a[href="https://www.tiktok.com/@tiktok_creator"]').parentElement.textContent).toContain('TikTok');
  api.getTrackedAccounts.mockResolvedValue({ data: [
    { username: 'tiktok_creator', platform: 'tiktok', status: 'active' },
    { username: 'instagram_creator', status: 'active' },
  ] });
  await render(<TrackedAccountsTab />);
  expect(container.querySelector('a[href="https://www.tiktok.com/@tiktok_creator"]')).toBeTruthy();
  expect(container.querySelector('a[href="https://instagram.com/instagram_creator"]')).toBeTruthy();
});

test.each([
  ['tiktok', 'https://www.tiktok.com/@creator', 'https://www.tiktok.com/@creator/video/123', 'TikTok'],
  [null, 'https://instagram.com/creator', 'https://www.instagram.com/reel/shortcode/', 'Instagram'],
])('content card uses %s profile and preserves its source reel URL', async (platform, profileUrl, postUrl, label) => {
  await render(<ContentCard post={{ id: 1, shortcode: 'shortcode', account_handle: 'creator', platform, post_url: postUrl }} />);
  expect(container.querySelector(`a[href="${profileUrl}"]`)).toBeTruthy();
  expect(container.querySelector(`a[href="${postUrl}"]`).textContent).toContain(`Open on ${label}`);
  expect([...container.querySelectorAll('span')].some(element => element.textContent === 'TikTok')).toBe(platform === 'tiktok');
});

test.each([['admin', AudioTab, 'getTrendingAudio'], ['model', SoundsPage, 'getMyTrendingAudio']])('%s audio only links Instagram sound IDs', async (surface, Component, method) => {
  api[method].mockResolvedValue({ data: { audio: [
    { audio_id: 'tt_123', audio_title: 'TikTok sound' },
    { audio_id: '456', audio_title: 'Instagram sound' },
  ] } });
  await render(<Component />);
  expect(container.textContent).toContain('TikTok sound');
  expect(container.querySelector('a[href="https://www.instagram.com/reels/audio/tt_123/"]')).toBeNull();
  expect(container.querySelector('a[href="https://www.instagram.com/reels/audio/456/"]')).toBeTruthy();
});

test.each([
  ['tiktok', 'https://www.tiktok.com/@creator/video/123', 'TikTok'],
  [null, 'https://www.instagram.com/reel/shortcode/', 'Instagram'],
])('model reel card badges and labels %s source without changing its URL', async (platform, postUrl, label) => {
  await render(<ReelCard post={{ id: 1, account_handle: 'creator', shortcode: 'shortcode', platform, post_url: postUrl }} />);
  const link = container.querySelector(`a[href="${postUrl}"]`);
  expect(link.getAttribute('title')).toBe(`Open on ${label}`);
  expect(link.getAttribute('aria-label')).toBe(`Open on ${label}`);
  expect([...container.querySelectorAll('span')].some(element => element.textContent === 'TikTok')).toBe(platform === 'tiktok');
});

test.each([
  ['tiktok', 'https://www.tiktok.com/@creator/video/123', 'TikTok'],
  [null, 'https://www.instagram.com/reel/shortcode/', 'IG'],
])('preview card badges and labels %s source after video playback fails', async (platform, postUrl, label) => {
  await render(<IdeaReel reel={{ id: 1, account_handle: 'creator', shortcode: 'shortcode', platform, post_url: postUrl }} active />);
  await act(async () => { Simulate.error(container.querySelector('video')); });
  expect(container.querySelector(`a[href="${postUrl}"]`).textContent).toContain(`Open on ${label}`);
  expect([...container.querySelectorAll('span')].some(element => element.textContent === 'TikTok')).toBe(platform === 'tiktok');
});

test('scrape form sends the TikTok username query type', async () => {
  await render(<ScrapeTab />);
  await change(container.querySelector('select'), 'tiktok_username');
  await change(container.querySelector('input[type="text"]'), '@pardisscarelllo');
  await submit();
  expect(api.triggerScrape).toHaveBeenCalledWith(expect.objectContaining({ query: '@pardisscarelllo', queryType: 'tiktok_username' }));
});

test('delete log uses TikTok post URLs while preserving Instagram permalink behavior', async () => {
  api.getDeleteLog.mockResolvedValue({ data: { entries: [
    { id: 1, shortcode: 'tt_123', platform: 'tiktok', post_url: 'https://www.tiktok.com/@creator/video/123' },
    { id: 2, shortcode: 'instagram', post_url: 'https://www.instagram.com/reel/instagram/' },
    { id: 3, shortcode: 'tt_missing', platform: 'tiktok' },
  ], stats: {}, total: 3, totalPages: 1 } });
  await render(<DeleteLogTab />);
  const links = [...container.querySelectorAll('a')];
  expect(links.find(link => link.textContent === 'tt_123').getAttribute('href')).toBe('https://www.tiktok.com/@creator/video/123');
  expect(links.find(link => link.textContent === 'instagram').getAttribute('href')).toBe('https://www.instagram.com/p/instagram/');
  expect(links.find(link => link.textContent === 'tt_missing').hasAttribute('href')).toBe(false);
});

test.each([
  ['tiktok', 'https://www.tiktok.com/@creator/video/123', 'https://www.tiktok.com/@creator/video/123'],
  [null, 'https://www.instagram.com/reel/shortcode/', 'https://www.instagram.com/p/shortcode/'],
  ['tiktok', null, null],
])('engagement best and worst post links respect %s platform', async (platform, postUrl, expectedUrl) => {
  api.getEngagementLeaderboard.mockResolvedValue({ data: [{ account_handle: 'creator' }] });
  const post = { shortcode: 'shortcode', platform, post_url: postUrl };
  api.getEngagementSummary.mockResolvedValue({ data: { handle: 'creator', best: post, worst: post } });
  await render(<EngagementTab />);
  await click([...container.querySelectorAll('button')].find(element => element.textContent.includes('@creator')));
  const links = [...container.querySelectorAll('a')];
  expect(links).toHaveLength(2);
  for (const link of links) expect(link.getAttribute('href')).toBe(expectedUrl);
});
