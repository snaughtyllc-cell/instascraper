import axios from 'axios';
import API_URL from './api-base';

const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
});

const MODEL_API_TIMEOUT = 20000;

export const triggerScrape = (data) => api.post('/scrape', data);
export const getScrapeJobs = () => api.get('/scrape/jobs');
export const getJobStatus = (id) => api.get(`/scrape/jobs/${id}`);

export const importUrls = (urls) => api.post('/scrape/import-urls', { urls });
export const getContent = (params) => api.get('/content', { params });
export const saveNotes = (id, notes) => api.post(`/content/${id}/notes`, { notes });
export const archivePost = (id, archived) => api.post(`/content/${id}/archive`, { archived });
export const setPostContentType = (id, contentType) => api.post(`/content/${id}/content-type`, { contentType });
export const bulkUpdateContent = (ids, action, value) => api.post('/content/bulk', { ids, action, value });
export const getContentTypes = () => api.get('/content-types');
export const addContentType = (label, description) => api.post('/content-types', { label, description });
export const updateContentType = (id, data) => api.patch(`/content-types/${id}`, data);
export const deleteContentType = (id) => api.delete(`/content-types/${id}`);
export const getCreators = () => api.get('/creators');
export const getLookTags = () => api.get('/look-tags');
export const addLookTag = (label, category) => api.post('/look-tags', { label, category });
export const deleteLookTag = (id) => api.delete(`/look-tags/${id}`);
export const addCreatorLookTag = (handle, tag) => api.post(`/creators/${encodeURIComponent(handle)}/look-tags`, { tag });
export const removeCreatorLookTag = (handle, tag) => api.delete(`/creators/${encodeURIComponent(handle)}/look-tags/${encodeURIComponent(tag)}`);
export const getLookBackfillEstimate = () => api.get('/sort/look-backfill/estimate');
export const startLookBackfill = () => api.post('/sort/look-backfill');
export const getTranscriptBackfillEstimate = () => api.get('/sort/transcript-backfill/estimate');
export const startTranscriptBackfill = () => api.post('/sort/transcript-backfill');
export const getTalkingRecheckEstimate = (modelId) => api.get('/sort/talking-recheck/estimate', { params: modelId ? { modelId } : undefined });
export const startTalkingRecheck = (modelId) => api.post('/sort/talking-recheck', { confirm: true }, { params: modelId ? { modelId } : undefined });

export const exportContent = (format = 'json', contentType = '') => {
  const params = new URLSearchParams({ format });
  if (contentType) params.set('contentType', contentType);
  window.open(`${api.defaults.baseURL}/export?${params}`, '_blank');
};

// Auto-sort review and administration
export const getNeedsLook = (params) => api.get('/sort/needs-look', { params });
export const createSuggestedType = (value) => api.post(`/sort/suggested-types/${encodeURIComponent(value)}/create`);
export const getBackfillEstimate = () => api.get('/sort/backfill/estimate');
export const startBackfill = () => api.post('/sort/backfill');
export const getSortUsage = () => api.get('/admin/sort-usage');
export const getStartFreshPreview = () => api.get('/sort/start-fresh/preview');
export const startFresh = () => api.post('/sort/start-fresh', { confirm: true });

export const getEngagementSummary = (handle) => api.get(`/engagement/summary/${handle}`);
export const getEngagementLeaderboard = () => api.get('/engagement/leaderboard');
export const getEngagementRollups = (handle) => api.get(`/engagement/rollups/${handle}`);
export const exportEngagement = (handle, format = 'csv') => {
  window.open(`${api.defaults.baseURL}/engagement/export/${handle}?format=${format}`, '_blank');
};

// Tracked accounts
export const getTrackedAccounts = (params) => api.get('/tracked', { params });
export const addTrackedAccount = (username, tags) => api.post('/tracked', { username, tags });
export const updateTrackedAccount = (username, data) => api.patch(`/tracked/${username}`, data);
export const removeTrackedAccount = (username) => api.delete(`/tracked/${username}`);
export const scrapeNow = (username) => api.post(`/tracked/${username}/scrape`);

// Suggested accounts
export const getSuggestedAccounts = (params) => api.get('/suggested', { params });
export const approveSuggested = (username, modelIds) => api.post(`/suggested/${encodeURIComponent(username)}/approve`, { modelIds });
export const dismissSuggested = (username) => api.post(`/suggested/${username}/dismiss`);
export const snoozeSuggested = (username) => api.post(`/suggested/${username}/snooze`);
export const approveSuggestedBulk = (usernames, modelIds) => api.post('/suggested/approve-bulk', { usernames, modelIds });
export const scrapeTrackedBulk = (usernames) => api.post('/tracked/scrape-bulk', { usernames });

// Reel Radar (keyword-driven creator discovery)
export const getRadarTerms = () => api.get('/radar/terms');
export const addRadarTerm = (term) => api.post('/radar/terms', { term });
export const setRadarTermStatus = (id, status) => api.patch(`/radar/terms/${id}`, { status });
export const removeRadarTerm = (id) => api.delete(`/radar/terms/${id}`);
export const triggerRadar = () => api.post('/radar/run');

// Delete log
export const getDeleteLog = (params) => api.get('/delete-log', { params });
export const restorePost = (id) => api.post(`/delete-log/${id}/restore`);

// Scheduler
export const getSchedulerStatus = () => api.get('/scheduler/status');
export const triggerJob = (job) => api.post(`/scheduler/run/${job}`);

// Admin cockpit
export const getModelCockpit = () => api.get('/admin/model-cockpit');

// Models
export const getModels = () => api.get('/models');
export const createModel = (data) => api.post('/models', data);
export const updateModel = (id, data) => api.put(`/models/${id}`, data);
export const deleteModel = (id) => api.delete(`/models/${id}`);
export const assignPostsToModel = (modelId, postIds) => api.post(`/models/${modelId}/assignments`, { postIds });
export const getModelActivity = (modelId) => api.get(`/models/${modelId}/activity`);
export const getAvailableNiches = () => api.get('/models/niches/available');
export const getNotionPersonas = () => api.get('/notion/personas');
export const previewNotionPersona = (pageId) => api.post(`/notion/personas/${pageId}/preview`);
export const importNotionPersona = (pageId, data) => api.post(`/notion/personas/${pageId}/import`, data);
export const resyncNotion = (id, confirm, confirmed) => api.post(`/models/${id}/resync-notion`, { confirm, confirmed });

// Ideas
export const generateIdeas = (modelId) => api.post(`/ideas/generate/${modelId}`);
export const getIdeas = (modelId) => api.get(`/ideas/${modelId}`);
export const getIdeaBatches = (modelId) => api.get(`/ideas/${modelId}/batches`);
export const deliverIdeas = (modelId, batchId) => api.post(`/ideas/deliver/${modelId}/${batchId}`);
export const getDeliveryLog = (modelId) => api.get(`/ideas/delivery-log/${modelId}`);
export const exportIdeas = (modelId, format = 'csv') => {
  window.open(`${api.defaults.baseURL}/ideas/export/${modelId}?format=${format}`, '_blank');
};
export const exportIdeasToNotion = (modelId, pageId) => api.post(`/ideas/export-notion/${modelId}`, { pageId });

// Model (self / me) endpoints
export const login = (email, password) => api.post('/login', email ? { email, password } : { password }, { timeout: MODEL_API_TIMEOUT });
export const getMyFeed = (page = 1, niche, options = {}) => api.get('/me/feed', { timeout: MODEL_API_TIMEOUT, params: { page, ...(niche ? { niche } : {}), ...(options.refresh ? { refresh: 1 } : {}) } });
export const getMyAssignments = () => api.get('/me/assignments', { timeout: MODEL_API_TIMEOUT });
export const getMySaves = () => api.get('/me/saves', { timeout: MODEL_API_TIMEOUT });
export const saveMyPost = (id) => api.post(`/me/saves/${id}`, undefined, { timeout: MODEL_API_TIMEOUT });
export const unsaveMyPost = (id) => api.delete(`/me/saves/${id}`, { timeout: MODEL_API_TIMEOUT });
export const sendMyPostFeedback = (id, feedback, notes = '') => api.post(`/me/feedback/${id}`, { feedback, notes }, { timeout: MODEL_API_TIMEOUT });
export const getMyIdeas = () => api.get('/me/ideas', { timeout: MODEL_API_TIMEOUT });
export const getMyTrendingAudio = () => api.get('/me/audio/trending', { timeout: MODEL_API_TIMEOUT });
export const getMyAudioReels = (audioId) => api.get(`/me/audio/${encodeURIComponent(audioId)}/reels`, { timeout: MODEL_API_TIMEOUT });

// Trending audio (admin, roster-wide)
export const getTrendingAudio = () => api.get('/audio/trending');
export const getAudioReels = (audioId) => api.get(`/audio/${encodeURIComponent(audioId)}/reels`);

export default api;

// Model workspaces
export const getWorkspace = (id) => api.get(`/workspaces/${id}`);
export const getWorkspaceTaste = (id) => api.get(`/workspaces/${id}/taste`);
export const getWorkspaceCreators = (id) => api.get(`/workspaces/${id}/creators`);
export const addWorkspaceCreator = (id, username) => api.post(`/workspaces/${id}/creators`, { username });
export const removeWorkspaceCreator = (id, username) => api.delete(`/workspaces/${id}/creators/${encodeURIComponent(username)}`);
export const getWorkspaceReels = (id, page = 1) => api.get(`/workspaces/${id}/reels`, { params: { page } });
export const getWorkspaceProposals = (id) => api.get(`/workspaces/${id}/proposals`);
export const refreshWorkspaceProposals = (id) => api.post(`/workspaces/${id}/proposals/refresh`);
export const confirmWorkspaceProposal = (id, username) => api.post(`/workspaces/${id}/proposals/${encodeURIComponent(username)}/confirm`);
export const rejectWorkspaceProposal = (id, username) => api.post(`/workspaces/${id}/proposals/${encodeURIComponent(username)}/reject`);
export const confirmAllWorkspaceProposals = (id) => api.post(`/workspaces/${id}/proposals/confirm-all`);
export const getWorkspaceSuggestions = (id) => api.get(`/workspaces/${id}/suggestions`);
export const approveWorkspaceSuggestion = (id, username) => api.post(`/workspaces/${id}/suggestions/${encodeURIComponent(username)}/approve`);
export const dismissWorkspaceSuggestion = (id, username) => api.post(`/workspaces/${id}/suggestions/${encodeURIComponent(username)}/dismiss`);
export const snoozeWorkspaceSuggestion = (id, username) => api.post(`/workspaces/${id}/suggestions/${encodeURIComponent(username)}/snooze`);
