import axios from 'axios';

const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:4000',
  withCredentials: true,
});

export const triggerScrape = (data) => api.post('/scrape', data);
export const getScrapeJobs = () => api.get('/scrape/jobs');
export const getJobStatus = (id) => api.get(`/scrape/jobs/${id}`);

export const getContent = (params) => api.get('/content', { params });
export const tagPost = (id, tag) => api.post(`/content/${id}/tag`, { tag });
export const saveNotes = (id, notes) => api.post(`/content/${id}/notes`, { notes });
export const archivePost = (id, archived) => api.post(`/content/${id}/archive`, { archived });
export const setCreatorType = (handle, contentType) => api.post(`/creators/${handle}/type`, { contentType });
export const setPostContentType = (id, contentType) => api.post(`/content/${id}/content-type`, { contentType });
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

// Delete log
export const getDeleteLog = (params) => api.get('/delete-log', { params });
export const restorePost = (id) => api.post(`/delete-log/${id}/restore`);

// Scheduler
export const getSchedulerStatus = () => api.get('/scheduler/status');
export const triggerJob = (job) => api.post(`/scheduler/run/${job}`);

// Models
export const getModels = () => api.get('/models');
export const createModel = (data) => api.post('/models', data);
export const updateModel = (id, data) => api.put(`/models/${id}`, data);
export const deleteModel = (id) => api.delete(`/models/${id}`);
export const getAvailableNiches = () => api.get('/models/niches/available');

// Ideas
export const generateIdeas = (modelId) => api.post(`/ideas/generate/${modelId}`);
export const getIdeas = (modelId) => api.get(`/ideas/${modelId}`);
export const getIdeaBatches = (modelId) => api.get(`/ideas/${modelId}/batches`);
export const deliverIdeas = (modelId, batchId) => api.post(`/ideas/deliver/${modelId}/${batchId}`);
export const getDeliveryLog = (modelId) => api.get(`/ideas/delivery-log/${modelId}`);

export default api;
