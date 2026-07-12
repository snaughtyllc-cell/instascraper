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
export const tagPost = (id, tag) => api.post(`/content/${id}/tag`, { tag });
export const saveNotes = (id, notes) => api.post(`/content/${id}/notes`, { notes });
export const archivePost = (id, archived) => api.post(`/content/${id}/archive`, { archived });
export const setCreatorType = (handle, contentType) => api.post(`/creators/${handle}/type`, { contentType });
export const setPostContentType = (id, contentType) => api.post(`/content/${id}/content-type`, { contentType });
export const bulkUpdateContent = (ids, action, value) => api.post('/content/bulk', { ids, action, value });
export const getContentTypes = () => api.get('/content-types');
export const addContentType = (label) => api.post('/content-types', { label });
export const deleteContentType = (id) => api.delete(`/content-types/${id}`);
export const getCreators = () => api.get('/creators');

export const exportContent = (format = 'json') => {
  window.open(`${api.defaults.baseURL}/export?format=${format}&tag=recreate`, '_blank');
};

export const getEngagementSummary = (handle) => api.get(`/engagement/summary/${handle}`);
export const getEngagementLeaderboard = () => api.get('/engagement/leaderboard');
export const getEngagementRollups = (handle) => api.get(`/engagement/rollups/${handle}`);
export const exportEngagement = (handle, format = 'csv') => {
  window.open(`${api.defaults.baseURL}/engagement/export/${handle}?format=${format}`, '_blank');
};

// Tracked accounts
export const getTrackedAccounts = () => api.get('/tracked');
export const addTrackedAccount = (username, tags) => api.post('/tracked', { username, tags });
export const updateTrackedAccount = (username, data) => api.patch(`/tracked/${username}`, data);
export const removeTrackedAccount = (username) => api.delete(`/tracked/${username}`);
export const scrapeNow = (username) => api.post(`/tracked/${username}/scrape`);

// Suggested accounts
export const getSuggestedAccounts = (params) => api.get('/suggested', { params });
export const approveSuggested = (username) => api.post(`/suggested/${username}/approve`);
export const dismissSuggested = (username) => api.post(`/suggested/${username}/dismiss`);
export const snoozeSuggested = (username) => api.post(`/suggested/${username}/snooze`);
export const approveSuggestedBulk = (usernames) => api.post('/suggested/approve-bulk', { usernames });
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
