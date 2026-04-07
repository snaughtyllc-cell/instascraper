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
export const exportEngagement = (handle, format = 'csv') => {
  window.open(`${api.defaults.baseURL}/engagement/export/${handle}?format=${format}`, '_blank');
};

export default api;
