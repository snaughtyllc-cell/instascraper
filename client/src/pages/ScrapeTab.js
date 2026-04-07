import React, { useState, useEffect } from 'react';
import { triggerScrape, getScrapeJobs } from '../api';

export default function ScrapeTab() {
  const [query, setQuery] = useState('');
  const [queryType, setQueryType] = useState('username');
  const [minLikes, setMinLikes] = useState('');
  const [minViews, setMinViews] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [jobs, setJobs] = useState([]);

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadJobs = async () => {
    try {
      const { data } = await getScrapeJobs();
      setJobs(data);
    } catch {}
  };

  const handleScrape = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await triggerScrape({ query, queryType, minLikes, minViews, startDate, endDate });
      setQuery('');
      await loadJobs();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const statusColor = (status) => {
    switch (status) {
      case 'completed': return 'text-green-400';
      case 'running': return 'text-gold';
      case 'failed': return 'text-red-400';
      default: return 'text-gray-400';
    }
  };

  return (
    <div className="space-y-8">
      {/* Scrape Form */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Start New Scrape</h2>
        <form onSubmit={handleScrape} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Query Type */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">Type</label>
              <select
                value={queryType}
                onChange={(e) => setQueryType(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm"
              >
                <option value="username">Username</option>
                <option value="hashtag">Hashtag</option>
                <option value="url">Post URL</option>
              </select>
            </div>

            {/* Query */}
            <div className="md:col-span-2">
              <label className="block text-sm text-gray-400 mb-1">
                {queryType === 'username' ? 'Username' : queryType === 'hashtag' ? 'Hashtag' : 'Post URL'}
              </label>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={queryType === 'username' ? 'garyvee' : queryType === 'hashtag' ? 'marketing' : 'https://instagram.com/p/...'}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-500"
                required
              />
            </div>
          </div>

          {/* Filters */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Min Likes</label>
              <input
                type="number"
                value={minLikes}
                onChange={(e) => setMinLikes(e.target.value)}
                placeholder="e.g. 1000"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Min Views</label>
              <input
                type="number"
                value={minViews}
                onChange={(e) => setMinViews(e.target.value)}
                placeholder="e.g. 10000"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm"
              />
            </div>
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-800 text-red-300 rounded-lg px-4 py-2 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="bg-gold hover:bg-gold-light text-gray-950 font-semibold px-6 py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            {loading ? 'Starting...' : 'Start Scraping'}
          </button>
        </form>
      </div>

      {/* Jobs List */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Recent Scrape Jobs</h2>
        {jobs.length === 0 ? (
          <p className="text-gray-500 text-sm">No scrape jobs yet.</p>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <div key={job.id} className="bg-gray-800/50 rounded-lg px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span className="text-sm text-gray-300 font-mono">{job.query_type}:</span>
                    <span className="text-sm text-white font-medium">{job.query}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    {job.posts_found > 0 && (
                      <span className="text-sm text-gray-400">{job.posts_found} posts</span>
                    )}
                    <span className={`text-sm font-medium capitalize ${statusColor(job.status)}`}>
                      {job.status === 'running' && (
                        <span className="inline-block w-2 h-2 bg-gold rounded-full animate-pulse mr-1.5 align-middle" />
                      )}
                      {job.status}
                    </span>
                  </div>
                </div>

                {/* Progress Bar */}
                {(job.status === 'running' || job.progress > 0) && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-700 ease-out ${
                            job.status === 'completed'
                              ? 'bg-green-500'
                              : job.status === 'failed'
                              ? 'bg-red-500'
                              : 'bg-gold'
                          }`}
                          style={{ width: `${job.progress || 0}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-400 tabular-nums w-10 text-right">
                        {job.progress || 0}%
                      </span>
                    </div>
                    {job.status_message && job.status !== 'completed' && (
                      <p className="text-xs text-gray-500">{job.status_message}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
