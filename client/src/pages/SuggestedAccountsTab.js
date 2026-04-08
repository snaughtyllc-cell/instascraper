import React, { useState, useEffect, useCallback } from 'react';
import { getSuggestedAccounts, approveSuggested, dismissSuggested, snoozeSuggested, triggerJob } from '../api';

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

const ER_COLORS = {
  high: 'text-green-400 bg-green-500/10 border-green-500/30',
  mid: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
  low: 'text-gray-400 bg-gray-500/10 border-gray-500/30',
};

function erStyle(er) {
  if (er >= 6) return ER_COLORS.high;
  if (er >= 2) return ER_COLORS.mid;
  return ER_COLORS.low;
}

export default function SuggestedAccountsTab() {
  const [suggestions, setSuggestions] = useState([]);
  const [sort, setSort] = useState('score');
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await getSuggestedAccounts({ status: 'pending', sort });
      setSuggestions(data);
    } catch (err) {
      console.error('Failed to load suggestions:', err);
    }
    setLoading(false);
  }, [sort]);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = async (username) => {
    await approveSuggested(username);
    load();
  };

  const handleDismiss = async (username) => {
    await dismissSuggested(username);
    load();
  };

  const handleSnooze = async (username) => {
    await snoozeSuggested(username);
    load();
  };

  const handleRunDiscovery = async () => {
    setDiscovering(true);
    await triggerJob('discovery');
    // Discovery takes several minutes (multiple Apify calls).
    // Poll every 15s until new suggestions appear or 5 min timeout.
    let elapsed = 0;
    const poll = setInterval(async () => {
      elapsed += 15;
      try {
        const { data } = await getSuggestedAccounts({ status: 'pending', sort });
        if (data.length > suggestions.length || elapsed >= 300) {
          clearInterval(poll);
          setSuggestions(data);
          setDiscovering(false);
        }
      } catch (e) {
        // keep polling
      }
    }, 15000);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-gold border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Suggested Accounts</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Discovered via caption mentions, photo tags, and hashtag overlap from tracked accounts.
            </p>
          </div>
          <div className="flex gap-3 items-center">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="score">Best Score</option>
              <option value="er">Highest ER</option>
              <option value="followers">Most Followers</option>
              <option value="newest">Most Recent</option>
            </select>
            <button
              onClick={handleRunDiscovery}
              disabled={discovering}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                discovering
                  ? 'bg-gold/20 border border-gold/40 text-gold animate-pulse'
                  : 'bg-gold hover:bg-gold-light text-gray-950 font-semibold'
              }`}
            >
              {discovering ? 'Discovering...' : 'Run Discovery'}
            </button>
          </div>
        </div>
      </div>

      {/* Suggestions List */}
      {suggestions.length === 0 ? (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-12 text-center">
          <p className="text-gray-500 text-lg">No suggestions yet.</p>
          <p className="text-gray-600 text-sm mt-1">Click "Run Discovery" to find new accounts based on your tracked accounts' networks.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {suggestions.map((s) => (
            <div key={s.username} className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3 hover:border-gray-700 transition-colors">
              {/* Header */}
              <div className="flex items-start justify-between">
                <div>
                  <a
                    href={`https://instagram.com/${s.username}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-bold text-gold hover:text-gold-light transition-colors"
                  >
                    @{s.username}
                  </a>
                  {s.bio && (
                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{s.bio}</p>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-white">{Math.round(s.suggestion_score)}%</div>
                  <div className="text-[10px] text-gray-500 uppercase">Score</div>
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-gray-800/50 rounded-lg p-2 text-center border border-gray-700/50">
                  <div className="text-sm font-bold text-white">{formatCount(s.followers)}</div>
                  <div className="text-[10px] text-gray-500">Followers</div>
                </div>
                <div className={`rounded-lg p-2 text-center border ${erStyle(s.avg_er)}`}>
                  <div className="text-sm font-bold">{s.avg_er}%</div>
                  <div className="text-[10px] opacity-75">Avg ER</div>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-center border border-gray-700/50">
                  <div className="text-sm font-bold text-white">{s.posts_per_week}</div>
                  <div className="text-[10px] text-gray-500">Posts/wk</div>
                </div>
              </div>

              {/* Content breakdown */}
              {s.content_breakdown && (
                <div className="text-xs text-gray-500">{s.content_breakdown}</div>
              )}

              {/* Top hashtags */}
              {s.top_hashtags && (
                <div className="flex flex-wrap gap-1">
                  {s.top_hashtags.split(',').filter(Boolean).map(tag => (
                    <span key={tag} className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20">
                      {tag.trim()}
                    </span>
                  ))}
                </div>
              )}

              {/* Relevance reason */}
              {s.relevance_reason && (
                <div className="text-xs text-gray-400 italic">{s.relevance_reason}</div>
              )}

              {/* Actions */}
              <div className="flex gap-1.5 pt-1">
                <button
                  onClick={() => handleApprove(s.username)}
                  className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-green-600 hover:bg-green-500 text-white transition-colors"
                >
                  Add to System
                </button>
                <button
                  onClick={() => handleSnooze(s.username)}
                  className="px-3 py-2 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-yellow-400 hover:border-yellow-600 transition-colors"
                >
                  Snooze 7d
                </button>
                <button
                  onClick={() => handleDismiss(s.username)}
                  className="px-3 py-2 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-red-400 hover:border-red-600 transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
