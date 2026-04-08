import React, { useState, useEffect, useCallback } from 'react';
import { getTrackedAccounts, addTrackedAccount, updateTrackedAccount, removeTrackedAccount, scrapeNow, getSchedulerStatus, triggerJob } from '../api';

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function timeAgo(dateStr) {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

export default function TrackedAccountsTab() {
  const [accounts, setAccounts] = useState([]);
  const [newUsername, setNewUsername] = useState('');
  const [newTags, setNewTags] = useState('');
  const [loading, setLoading] = useState(true);
  const [scheduler, setScheduler] = useState(null);
  const [scraping, setScraping] = useState({});

  const load = useCallback(async () => {
    try {
      const { data } = await getTrackedAccounts();
      setAccounts(data);
    } catch (err) {
      console.error('Failed to load accounts:', err);
    }
    setLoading(false);
  }, []);

  const loadScheduler = useCallback(async () => {
    try {
      const { data } = await getSchedulerStatus();
      setScheduler(data);
    } catch {}
  }, []);

  useEffect(() => {
    load();
    loadScheduler();
  }, [load, loadScheduler]);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newUsername.trim()) return;
    await addTrackedAccount(newUsername.trim(), newTags.trim());
    setNewUsername('');
    setNewTags('');
    load();
  };

  const handlePause = async (username, currentStatus) => {
    const newStatus = currentStatus === 'active' ? 'paused' : 'active';
    await updateTrackedAccount(username, { status: newStatus });
    load();
  };

  const handleRemove = async (username) => {
    await removeTrackedAccount(username);
    load();
  };

  const handleScrapeNow = async (username) => {
    setScraping(s => ({ ...s, [username]: true }));
    try {
      await scrapeNow(username);
    } catch (err) {
      console.error('Scrape failed:', err);
    }
    setTimeout(() => {
      setScraping(s => ({ ...s, [username]: false }));
      load();
    }, 5000);
  };

  const handleTriggerJob = async (job) => {
    await triggerJob(job);
    loadScheduler();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-gold border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const active = accounts.filter(a => a.status === 'active');
  const paused = accounts.filter(a => a.status === 'paused');

  return (
    <div className="space-y-6">
      {/* Add Account Form */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <h2 className="text-lg font-bold text-white mb-4">Add Account to Track</h2>
        <form onSubmit={handleAdd} className="flex gap-3">
          <input
            type="text"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder="@username"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-500"
          />
          <input
            type="text"
            value={newTags}
            onChange={(e) => setNewTags(e.target.value)}
            placeholder="Tags (comma separated)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-500"
          />
          <button
            type="submit"
            className="bg-gold hover:bg-gold-light text-gray-950 font-semibold px-6 py-2.5 rounded-lg text-sm transition-colors"
          >
            + Add
          </button>
        </form>
      </div>

      {/* Scheduler Status */}
      {scheduler && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-white">Scheduler</h2>
            <div className="flex gap-2">
              <button onClick={() => handleTriggerJob('auto-scrape')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-600 transition-colors">
                Run Scrape Now
              </button>
              <button onClick={() => handleTriggerJob('rollup')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-600 transition-colors">
                Run Rollup
              </button>
              <button onClick={() => handleTriggerJob('cleanup')} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-600 transition-colors">
                Run Cleanup
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Object.entries(scheduler).map(([key, job]) => (
              <div key={key} className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
                <div className="text-xs text-gray-500 uppercase tracking-wider">{key.replace(/([A-Z])/g, ' $1')}</div>
                <div className={`text-sm font-medium mt-1 ${job.status === 'running' ? 'text-gold' : job.status === 'error' ? 'text-red-400' : 'text-gray-300'}`}>
                  {job.status}
                </div>
                {job.lastRun && <div className="text-xs text-gray-500 mt-0.5">Last: {timeAgo(job.lastRun)}</div>}
                {job.message && <div className="text-xs text-gray-400 mt-0.5 truncate">{job.message}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active Accounts */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Active Accounts</h2>
          <span className="text-sm text-gray-500">{active.length} tracked</span>
        </div>

        {active.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No accounts tracked yet. Add one above to get started.
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {active.map((account) => (
              <div key={account.username} className="px-5 py-3.5 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <a
                      href={`https://instagram.com/${account.username}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-semibold text-gold hover:text-gold-light transition-colors"
                    >
                      @{account.username}
                    </a>
                    {account.tags && (
                      <div className="flex gap-1">
                        {account.tags.split(',').filter(Boolean).map(tag => (
                          <span key={tag} className="px-1.5 py-0.5 rounded text-[10px] bg-gray-800 text-gray-400 border border-gray-700">
                            {tag.trim()}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {formatCount(account.followers)} followers &middot; {account.post_count || 0} posts &middot; {account.avg_er || 0}% avg ER &middot; Scraped {timeAgo(account.last_scraped_at)}
                  </div>
                </div>

                <div className="flex gap-1.5">
                  <button
                    onClick={() => handleScrapeNow(account.username)}
                    disabled={scraping[account.username]}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      scraping[account.username]
                        ? 'bg-gold/20 border-gold/40 text-gold animate-pulse'
                        : 'bg-gray-800 border-gray-700 text-gray-300 hover:text-white hover:border-gray-600'
                    }`}
                  >
                    {scraping[account.username] ? 'Scraping...' : 'Scrape'}
                  </button>
                  <button
                    onClick={() => handlePause(account.username, account.status)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-yellow-400 hover:border-yellow-600 transition-colors"
                  >
                    Pause
                  </button>
                  <button
                    onClick={() => handleRemove(account.username)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-red-400 hover:border-red-600 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Paused Accounts */}
      {paused.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Paused Accounts</h2>
            <span className="text-sm text-gray-500">{paused.length} paused</span>
          </div>
          <div className="divide-y divide-gray-800">
            {paused.map((account) => (
              <div key={account.username} className="px-5 py-3.5 flex items-center gap-4 opacity-60">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-semibold text-gray-400">@{account.username}</span>
                  <div className="text-xs text-gray-600 mt-0.5">
                    {formatCount(account.followers)} followers &middot; Last scraped {timeAgo(account.last_scraped_at)}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => handlePause(account.username, account.status)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-green-400 hover:border-green-600 transition-colors"
                  >
                    Resume
                  </button>
                  <button
                    onClick={() => handleRemove(account.username)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-red-400 hover:border-red-600 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
