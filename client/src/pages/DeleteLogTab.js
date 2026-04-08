import React, { useState, useEffect, useCallback } from 'react';
import { getDeleteLog, restorePost } from '../api';

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

export default function DeleteLogTab() {
  const [entries, setEntries] = useState([]);
  const [stats, setStats] = useState({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { data } = await getDeleteLog({ page, limit: 50 });
      setEntries(data.entries);
      setStats(data.stats);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch (err) {
      console.error('Failed to load delete log:', err);
    }
    setLoading(false);
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRestore = async (id) => {
    await restorePost(id);
    load();
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
      {/* Stats Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Last 7 Days</div>
          <div className="text-2xl font-bold text-white mt-1">{stats.last_7_days || 0}</div>
          <div className="text-xs text-gray-500">posts deleted</div>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Last 30 Days</div>
          <div className="text-2xl font-bold text-white mt-1">{stats.last_30_days || 0}</div>
          <div className="text-xs text-gray-500">posts deleted</div>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Restored</div>
          <div className="text-2xl font-bold text-green-400 mt-1">{stats.restored || 0}</div>
          <div className="text-xs text-gray-500">posts recovered</div>
        </div>
      </div>

      {/* Delete Log Table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Deletion Log</h2>
          <span className="text-sm text-gray-500">{total} total entries</span>
        </div>

        {entries.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No posts have been auto-deleted yet. The cleanup job runs nightly at 2 AM.
          </div>
        ) : (
          <>
            {/* Table header */}
            <div className="grid grid-cols-12 gap-2 px-5 py-2.5 text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800 bg-gray-900/50">
              <div className="col-span-2">Post</div>
              <div className="col-span-2">Account</div>
              <div className="col-span-2">Reason</div>
              <div className="col-span-1">Views</div>
              <div className="col-span-1">Likes</div>
              <div className="col-span-2">Deleted</div>
              <div className="col-span-2">Action</div>
            </div>

            {/* Table rows */}
            <div className="divide-y divide-gray-800">
              {entries.map((entry) => (
                <div key={entry.id} className={`grid grid-cols-12 gap-2 px-5 py-3 items-center ${entry.restored_at ? 'opacity-40' : ''}`}>
                  <div className="col-span-2">
                    <a
                      href={`https://www.instagram.com/p/${entry.shortcode}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-gold hover:text-gold-light font-mono"
                    >
                      {entry.shortcode}
                    </a>
                  </div>
                  <div className="col-span-2 text-xs text-gray-400">@{entry.account_handle}</div>
                  <div className="col-span-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      entry.reason === 'auto:unreferenced_30d'
                        ? 'bg-orange-500/10 border-orange-500/30 text-orange-400'
                        : 'bg-gray-500/10 border-gray-500/30 text-gray-400'
                    }`}>
                      {entry.reason === 'auto:unreferenced_30d' ? 'Auto: 30d unused' : entry.reason}
                    </span>
                  </div>
                  <div className="col-span-1 text-xs text-gray-400">{formatCount(entry.view_count)}</div>
                  <div className="col-span-1 text-xs text-gray-400">{formatCount(entry.like_count)}</div>
                  <div className="col-span-2 text-xs text-gray-500">{formatDate(entry.deleted_at)}</div>
                  <div className="col-span-2">
                    {entry.restored_at ? (
                      <span className="text-xs text-green-400">Restored</span>
                    ) : (
                      <button
                        onClick={() => handleRestore(entry.id)}
                        className="px-3 py-1 rounded-lg text-xs font-medium bg-green-600/20 border border-green-600/40 text-green-400 hover:bg-green-600/30 transition-colors"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-30"
          >
            Previous
          </button>
          <span className="text-sm text-gray-400">Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
