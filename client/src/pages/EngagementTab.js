import React, { useState, useEffect } from 'react';
import { getEngagementLeaderboard, getEngagementSummary, exportEngagement } from '../api';

const ER_COLORS = {
  Viral: 'text-red-400 bg-red-500/10 border-red-500/30',
  Good: 'text-green-400 bg-green-500/10 border-green-500/30',
  Average: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
  Low: 'text-gray-400 bg-gray-500/10 border-gray-500/30',
};

const TREND_ICONS = {
  Up: { icon: '\u2191', color: 'text-green-400', label: 'Trending Up' },
  Down: { icon: '\u2193', color: 'text-red-400', label: 'Trending Down' },
  Stable: { icon: '\u2192', color: 'text-gray-400', label: 'Stable' },
};

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

export default function EngagementTab() {
  const [leaderboard, setLeaderboard] = useState([]);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadLeaderboard();
  }, []);

  const loadLeaderboard = async () => {
    try {
      const { data } = await getEngagementLeaderboard();
      setLeaderboard(data);
    } catch (err) {
      console.error('Failed to load leaderboard:', err);
    }
    setLoading(false);
  };

  const selectAccount = async (handle) => {
    setSelectedAccount(handle);
    setSummary(null);
    try {
      const { data } = await getEngagementSummary(handle);
      setSummary(data);
    } catch (err) {
      console.error('Failed to load summary:', err);
    }
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
      {/* Leaderboard */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Engagement Leaderboard</h2>
          <span className="text-sm text-gray-500">{leaderboard.length} accounts</span>
        </div>

        {leaderboard.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No engagement data yet. Scrape some accounts to see ER stats.
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {leaderboard.map((account, i) => {
              const erStyle = ER_COLORS[account.er_label] || ER_COLORS.Low;
              const isSelected = selectedAccount === account.account_handle;
              return (
                <button
                  key={account.account_handle}
                  onClick={() => selectAccount(account.account_handle)}
                  className={`w-full px-5 py-3.5 flex items-center gap-4 text-left transition-colors hover:bg-gray-800/60 ${
                    isSelected ? 'bg-gray-800/80 border-l-2 border-l-gold' : ''
                  }`}
                >
                  {/* Rank */}
                  <span className="text-lg font-bold text-gray-600 w-8 text-center">
                    {i + 1}
                  </span>

                  {/* Account info */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white truncate">
                      @{account.account_handle}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {account.post_count} posts &middot; {formatCount(account.followers)} followers
                    </div>
                  </div>

                  {/* ER Badge */}
                  <div className={`px-3 py-1.5 rounded-lg border text-sm font-bold ${erStyle}`}>
                    {account.avg_er}% <span className="text-xs font-normal opacity-75">avg ER</span>
                  </div>

                  {/* Best ER */}
                  <div className="text-right hidden sm:block">
                    <div className="text-xs text-gray-500">Best</div>
                    <div className="text-sm font-medium text-green-400">{account.best_er}%</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Account Detail Panel */}
      {summary && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">
              @{summary.handle} <span className="text-gray-500 font-normal">— ER Summary</span>
            </h2>
            <div className="flex gap-2">
              <button
                onClick={() => exportEngagement(summary.handle, 'csv')}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-600 transition-colors flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Export CSV
              </button>
              <button
                onClick={() => exportEngagement(summary.handle, 'json')}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
              >
                JSON
              </button>
            </div>
          </div>

          <div className="p-5 grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Average ER */}
            <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700/50">
              <div className="text-xs text-gray-500 uppercase tracking-wider">Avg Engagement</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-white">{summary.avgER}%</span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${ER_COLORS[summary.erLabel] || ER_COLORS.Low}`}>
                  {summary.erLabel}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-1">{summary.postCount} posts analyzed</div>
            </div>

            {/* Trend */}
            <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700/50">
              <div className="text-xs text-gray-500 uppercase tracking-wider">ER Trend</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className={`text-2xl font-bold ${TREND_ICONS[summary.trend]?.color || 'text-gray-400'}`}>
                  {TREND_ICONS[summary.trend]?.icon} {summary.trend}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {summary.firstHalfAvg}% &rarr; {summary.secondHalfAvg}%
              </div>
            </div>

            {/* Best Post */}
            {summary.best && (
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700/50">
                <div className="text-xs text-gray-500 uppercase tracking-wider">Best Post</div>
                <div className="mt-2">
                  <span className="text-2xl font-bold text-green-400">{summary.best.er_percent}%</span>
                  <span className={`ml-2 text-xs font-medium px-2 py-0.5 rounded-full border ${ER_COLORS[summary.best.er_label] || ER_COLORS.Low}`}>
                    {summary.best.er_label}
                  </span>
                </div>
                <a
                  href={`https://www.instagram.com/p/${summary.best.shortcode}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gold hover:text-gold-light mt-1 inline-block"
                >
                  {summary.best.shortcode} &rarr;
                </a>
              </div>
            )}

            {/* Worst Post */}
            {summary.worst && (
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700/50">
                <div className="text-xs text-gray-500 uppercase tracking-wider">Worst Post</div>
                <div className="mt-2">
                  <span className="text-2xl font-bold text-red-400">{summary.worst.er_percent}%</span>
                  <span className={`ml-2 text-xs font-medium px-2 py-0.5 rounded-full border ${ER_COLORS[summary.worst.er_label] || ER_COLORS.Low}`}>
                    {summary.worst.er_label}
                  </span>
                </div>
                <a
                  href={`https://www.instagram.com/p/${summary.worst.shortcode}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gold hover:text-gold-light mt-1 inline-block"
                >
                  {summary.worst.shortcode} &rarr;
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
