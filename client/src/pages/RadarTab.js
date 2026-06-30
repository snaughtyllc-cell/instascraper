import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { addTrackedAccount, bulkRadarReels, dismissRadarReel, getRadarReels, saveRadarReel } from '../api';
import BulkActionBar from '../components/BulkActionBar';
import ContentCard from '../components/ContentCard';

function formatBreakout(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0x median';
  return `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)}× median`;
}

function radarBadges(reel) {
  return [
    {
      label: 'untracked',
      position: 'topRight',
      className: 'bg-gray-950/85 border border-gray-700 text-gray-200 px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide',
    },
    {
      label: formatBreakout(reel.breakout_score),
      position: 'bottomRight',
      title: reel.author_median_views ? `Author median: ${Number(reel.author_median_views).toLocaleString()} views` : undefined,
      className: 'bg-gold/95 text-gray-950 px-2 py-0.5 rounded-full text-xs font-bold',
    },
    {
      label: `via #${reel.discovered_via || 'unknown'}`,
      position: 'bottomLeft',
      className: 'bg-gray-950/85 border border-gray-700 text-gray-300 px-2 py-0.5 rounded-full text-xs font-medium',
    },
  ];
}

export default function RadarTab() {
  const [reels, setReels] = useState([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ term: '', min_breakout: '' });
  const [selected, setSelected] = useState(new Set());
  const [actionMessage, setActionMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');

  const loadReels = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { status: 'new', limit: 60 };
      if (filters.term) params.term = filters.term;
      if (filters.min_breakout) params.min_breakout = filters.min_breakout;
      const { data } = await getRadarReels(params);
      const nextReels = Array.isArray(data?.reels) ? data.reels : [];
      setReels(nextReels);
      setTotal(Number(data?.total) || nextReels.length);
      setSelected((prev) => new Set([...prev].filter((sc) => nextReels.some((r) => r.shortcode === sc))));
    } catch (err) {
      console.error('Failed to load Radar reels:', err);
      setError(err.response?.data?.error || err.message || 'Failed to load Radar reels');
      setReels([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadReels();
  }, [loadReels]);

  const terms = useMemo(() => (
    [...new Set(reels.map((r) => r.discovered_via).filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b)))
  ), [reels]);

  const handleFilterChange = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setSelected(new Set());
    setActionMessage('');
  };

  const removeFromFeed = (shortcodes) => {
    const gone = new Set(shortcodes);
    setReels((prev) => prev.filter((reel) => !gone.has(reel.shortcode)));
    setTotal((prev) => Math.max(0, prev - gone.size));
    setSelected((prev) => new Set([...prev].filter((sc) => !gone.has(sc))));
  };

  const handleSave = async (reel) => {
    setActing(true);
    setActionMessage('');
    try {
      await saveRadarReel(reel.shortcode);
      removeFromFeed([reel.shortcode]);
      setActionMessage(`Saved ${reel.shortcode} to Library.`);
    } catch (err) {
      console.error('Failed to save Radar reel:', err);
      setError(err.response?.data?.error || err.message || 'Failed to save Radar reel');
    } finally {
      setActing(false);
    }
  };

  const handleDismiss = async (reel) => {
    setActing(true);
    setActionMessage('');
    try {
      await dismissRadarReel(reel.shortcode);
      removeFromFeed([reel.shortcode]);
      setActionMessage(`Dismissed ${reel.shortcode}.`);
    } catch (err) {
      console.error('Failed to dismiss Radar reel:', err);
      setError(err.response?.data?.error || err.message || 'Failed to dismiss Radar reel');
    } finally {
      setActing(false);
    }
  };

  const handleTrackAuthor = async (reel) => {
    if (!reel.account_handle) return;
    setActing(true);
    setActionMessage('');
    try {
      await addTrackedAccount(reel.account_handle, `radar:${reel.discovered_via || 'radar'}`);
      setActionMessage(`Tracking @${reel.account_handle}.`);
    } catch (err) {
      console.error('Failed to track Radar author:', err);
      setError(err.response?.data?.error || err.message || 'Failed to track author');
    } finally {
      setActing(false);
    }
  };

  const toggleSelect = (shortcode) => {
    if (!shortcode) return;
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(shortcode) ? next.delete(shortcode) : next.add(shortcode);
      return next;
    });
  };

  const selectAllOnPage = () => setSelected(new Set(reels.map((r) => r.shortcode).filter(Boolean)));
  const clearSelection = () => setSelected(new Set());

  const handleBulk = async (action) => {
    const shortcodes = [...selected];
    if (shortcodes.length === 0) return;
    setActing(true);
    setActionMessage('');
    try {
      await bulkRadarReels(shortcodes, action);
      clearSelection();
      await loadReels();
      setActionMessage(`${action === 'save' ? 'Saved' : 'Dismissed'} ${shortcodes.length} Radar reel${shortcodes.length === 1 ? '' : 's'}.`);
    } catch (err) {
      console.error('Failed to bulk update Radar reels:', err);
      setError(err.response?.data?.error || err.message || 'Bulk action failed');
    } finally {
      setActing(false);
    }
  };

  const renderActions = (reel) => (
    <div className="grid grid-cols-2 gap-1.5 pt-1">
      <button
        onClick={() => handleSave(reel)}
        disabled={acting}
        className="px-2 py-1.5 rounded-lg text-xs font-medium bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Save
      </button>
      <button
        onClick={() => handleDismiss(reel)}
        disabled={acting}
        className="px-2 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-red-300 hover:border-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Dismiss
      </button>
      <button
        onClick={() => handleTrackAuthor(reel)}
        disabled={acting || !reel.account_handle}
        className="px-2 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gold hover:border-gold/70 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Track author
      </button>
      {reel.post_url ? (
        <a
          href={reel.post_url}
          target="_blank"
          rel="noopener noreferrer"
          className="px-2 py-1.5 rounded-lg text-xs font-medium text-center bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
        >
          Open
        </a>
      ) : (
        <span className="px-2 py-1.5 rounded-lg text-xs text-center bg-gray-800/50 border border-gray-800 text-gray-600">Open</span>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-white">Radar</h2>
            <p className="text-sm text-gray-500 mt-0.5">{total} new reels surfaced</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <label className="text-xs text-gray-500">
              <span className="block mb-1">Term</span>
              <select
                value={filters.term}
                onChange={(e) => handleFilterChange('term', e.target.value)}
                className="w-full sm:w-44 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
              >
                <option value="">All terms</option>
                {terms.map((term) => (
                  <option key={term} value={term}>#{term}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-500">
              <span className="block mb-1">Min breakout</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={filters.min_breakout}
                onChange={(e) => handleFilterChange('min_breakout', e.target.value)}
                placeholder="Any"
                className="w-full sm:w-36 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600"
              />
            </label>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {actionMessage && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3 text-sm text-green-300">
          {actionMessage}
        </div>
      )}

      <BulkActionBar
        count={selected.size}
        actions={[
          {
            label: 'Bulk Save',
            onClick: () => handleBulk('save'),
            disabled: acting,
            className: 'px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-green-600 hover:bg-green-500 text-white disabled:opacity-50 disabled:cursor-not-allowed',
          },
          {
            label: 'Bulk Dismiss',
            onClick: () => handleBulk('dismiss'),
            disabled: acting,
            className: 'px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gray-800 border border-gray-700 text-red-300 hover:border-red-500 disabled:opacity-50 disabled:cursor-not-allowed',
          },
        ]}
        onSelectAll={selectAllOnPage}
        onClear={clearSelection}
      />

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-500">
          <svg className="w-6 h-6 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading...
        </div>
      ) : reels.length === 0 ? (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-12 text-center">
          <p className="text-gray-500 text-lg">No Radar reels found.</p>
          <p className="text-gray-600 text-sm mt-1">Try adjusting filters after the next Radar run.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {reels.map((reel) => (
            <ContentCard
              key={reel.shortcode}
              post={reel}
              variant="radar"
              thumbnailBadges={radarBadges(reel)}
              selected={selected.has(reel.shortcode)}
              onToggleSelect={toggleSelect}
              onUpdate={loadReels}
              actionSlot={renderActions(reel)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
