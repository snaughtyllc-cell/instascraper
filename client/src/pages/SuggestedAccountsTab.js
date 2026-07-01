import React, { useState, useEffect, useCallback } from 'react';
import { getSuggestedAccounts, approveSuggested, dismissSuggested, snoozeSuggested, triggerJob, approveSuggestedBulk, scrapeTrackedBulk } from '../api';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:4000';

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function reelStats(reels) {
  if (!reels || reels.length === 0) return { avgViews: 0, avgER: 0 };
  const n = reels.length;
  const avgViews = Math.round(reels.reduce((sum, r) => sum + (Number(r.view_count) || 0), 0) / n);
  const avgER = Math.round((reels.reduce((sum, r) => {
    const v = Number(r.view_count) || 0;
    return sum + (v > 0 ? ((Number(r.like_count) || 0) + (Number(r.comment_count) || 0)) / v * 100 : 0);
  }, 0) / n) * 100) / 100;
  return { avgViews, avgER };
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

function SuggestedReel({ reel }) {
  const [playing, setPlaying] = useState(false);
  const openIG = () => window.open(reel.permalink || `https://instagram.com/reel/${reel.shortcode}/`, '_blank', 'noopener');
  if (playing && reel.video_url) {
    return (
      <video
        src={reel.video_url}
        controls
        autoPlay
        onError={() => { setPlaying(false); openIG(); }}
        className="w-full aspect-[9/16] object-cover rounded-lg bg-black"
      />
    );
  }
  return (
    <button
      onClick={() => (reel.video_url ? setPlaying(true) : openIG())}
      className="relative w-full aspect-[9/16] rounded-lg overflow-hidden bg-gray-800 group/reel"
    >
      <img
        src={`${API_URL}/suggested/reels/${reel.id}/thumb`}
        alt=""
        loading="lazy"
        className="w-full h-full object-cover"
      />
      <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover/reel:opacity-100 transition-opacity">
        <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
      </span>
      <span className="absolute bottom-1 left-1 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded">
        {formatCount(reel.view_count)}
      </span>
    </button>
  );
}

function SuggestedReelStrip({ reels }) {
  if (!reels || reels.length === 0) return null;
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {reels.map((r) => <SuggestedReel key={r.id} reel={r} />)}
    </div>
  );
}

export default function SuggestedAccountsTab() {
  const [suggestions, setSuggestions] = useState([]);
  const [sort, setSort] = useState('score');
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [showUnclassified, setShowUnclassified] = useState(false);
  const [threshold, setThreshold] = useState(() => {
    const v = Number(localStorage.getItem('suggestScoreThreshold'));
    return Number.isFinite(v) && v > 0 ? v : 60;
  });
  useEffect(() => { localStorage.setItem('suggestScoreThreshold', String(threshold)); }, [threshold]);
  const [showLowScore, setShowLowScore] = useState(false);

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

  const handleBulkApprove = async () => {
    const usernames = [...selected];
    await approveSuggestedBulk(usernames);
    setSelected(new Set());
    load();
  };

  const handleBulkApproveScrape = async () => {
    const usernames = [...selected];
    await approveSuggestedBulk(usernames);
    const { data } = await scrapeTrackedBulk(usernames);
    setSelected(new Set());
    if (data.stopped) alert(`Stopped at budget: ${data.stopped.message}`);
    load();
  };

  const toggleSelected = (username) => {
    setSelected(prev => {
      const s = new Set(prev);
      s.has(username) ? s.delete(username) : s.add(username);
      return s;
    });
  };

  const female = suggestions.filter((s) => s.gender === 'female');
  const unclassified = suggestions.filter((s) => s.gender !== 'female');

  const allFemaleSelected = female.length > 0 && female.every((s) => selected.has(s.username));
  const toggleSelectAllFemale = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (female.length > 0 && female.every((s) => prev.has(s.username))) {
        female.forEach((s) => next.delete(s.username)); // all selected → deselect them
      } else {
        female.forEach((s) => next.add(s.username));     // select all visible female
      }
      return next;
    });
  };

  const renderCard = (s) => (
    <div key={s.username} className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3 hover:border-gray-700 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={selected.has(s.username)}
            onChange={() => toggleSelected(s.username)}
            className="mt-1 accent-gold cursor-pointer"
          />
          <div>
            <a
              href={`https://instagram.com/${s.username}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-bold text-gold hover:text-gold-light transition-colors"
            >
              @{s.username}
            </a>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                s.gender === 'female'
                  ? 'bg-green-500/10 text-green-400 border-green-500/30'
                  : 'bg-gray-700/40 text-gray-400 border-gray-600/40'
              }`}>
                {s.gender === 'female' ? '♀ Female' : 'Unclassified'}
              </span>
            </div>
            {s.bio && (
              <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{s.bio}</p>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold text-white">{Math.round(s.suggestion_score)}%</div>
          <div className="text-[10px] text-gray-500 uppercase">Score</div>
        </div>
      </div>

      {/* Stats (reel-derived) */}
      {(() => {
        const { avgViews, avgER } = reelStats(s.top_reels);
        const reelCount = (s.top_reels || []).length;
        return (
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-gray-800/50 rounded-lg p-2 text-center border border-gray-700/50">
              <div className="text-sm font-bold text-white">{reelCount ? formatCount(avgViews) : '—'}</div>
              <div className="text-[10px] text-gray-500">Avg Views</div>
            </div>
            <div className={`rounded-lg p-2 text-center border ${erStyle(avgER)}`}>
              <div className="text-sm font-bold">{reelCount ? `${avgER}%` : '—'}</div>
              <div className="text-[10px] opacity-75">Reel ER</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center border border-gray-700/50">
              <div className="text-sm font-bold text-white">{s.followers > 0 ? formatCount(s.followers) : reelCount}</div>
              <div className="text-[10px] text-gray-500">{s.followers > 0 ? 'Followers' : 'Reels'}</div>
            </div>
          </div>
        );
      })()}

      {/* Top reels */}
      <SuggestedReelStrip reels={s.top_reels} />

      {/* Content breakdown */}
      {s.content_breakdown && (
        <div className="text-xs text-gray-500">{s.content_breakdown}</div>
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
  );

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
              Female creators discovered from caption mentions and collab tags on your tracked accounts.
            </p>
          </div>
          <div className="flex gap-3 items-center">
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              Min score
              <input
                type="number" min="0" max="100" value={threshold}
                onChange={(e) => setThreshold(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white"
              />
            </label>
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

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-10 bg-gray-900 border border-gold/40 rounded-xl p-3 flex items-center gap-3">
          <span className="text-sm text-gray-300">{selected.size} selected</span>
          <button onClick={handleBulkApprove} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-600 hover:bg-green-500 text-white">
            Approve {selected.size} (paused)
          </button>
          <button onClick={handleBulkApproveScrape} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gold hover:bg-gold-light text-gray-950">
            Approve &amp; Scrape {selected.size}
          </button>
          <button onClick={() => setSelected(new Set())} className="px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white">Clear</button>
        </div>
      )}

      {/* Suggestions List */}
      {suggestions.length === 0 ? (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-12 text-center">
          <p className="text-gray-500 text-lg">No suggestions yet.</p>
          <p className="text-gray-600 text-sm mt-1">Click "Run Discovery" to find new accounts based on your tracked accounts' networks.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Female section */}
          {female.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500">{female.length} female</span>
                <button
                  onClick={toggleSelectAllFemale}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-600"
                >
                  {allFemaleSelected ? 'Deselect all' : `Select all ${female.length} female`}
                </button>
              </div>
              {(() => {
                const above = female.filter((s) => (s.suggestion_score || 0) >= threshold);
                const below = female.filter((s) => (s.suggestion_score || 0) < threshold);
                return (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {above.map(renderCard)}
                    </div>
                    {below.length > 0 && (
                      <div className="mt-3">
                        <button
                          onClick={() => setShowLowScore((v) => !v)}
                          className="text-sm text-gray-400 hover:text-white transition-colors mb-3"
                        >
                          {showLowScore ? '▾' : '▸'} Show {below.length} lower-scoring (under {threshold}%)
                        </button>
                        {showLowScore && (
                          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                            {below.map(renderCard)}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {/* Unclassified expander */}
          {unclassified.length > 0 && (
            <div>
              <button
                onClick={() => setShowUnclassified((v) => !v)}
                className="text-sm text-gray-400 hover:text-white transition-colors mb-3"
              >
                {showUnclassified ? '▾' : '▸'} Show {unclassified.length} unclassified
              </button>
              {showUnclassified && (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {unclassified.map(renderCard)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
