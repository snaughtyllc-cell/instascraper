import api, { addWorkspaceCreator } from './api';

jest.mock('axios', () => ({ create: () => ({ post: jest.fn() }) }));

test('workspace creator requests forward the selected platform', () => {
  addWorkspaceCreator(9, 'creator', 'tiktok');
  expect(api.post).toHaveBeenLastCalledWith('/workspaces/9/creators', { username: 'creator', platform: 'tiktok' });
  addWorkspaceCreator(9, 'creator');
  expect(api.post).toHaveBeenLastCalledWith('/workspaces/9/creators', { username: 'creator' });
});
