import React, { useState, useEffect, useCallback } from 'react';
import { getContent, getCreators, exportContent, importUrls } from '../api';
import ContentCard from '../components/ContentCard';
import FilterBar from '../components/FilterBar';

export default function LibraryTab() {
  const [posts, setPosts] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [accounts, setAccounts] = useState([]);
  const [creatorTypes, setCreatorTypes] = useState({});
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [filters, setFilters] = useState({
    sort: 'newest',
    tag: '',
    account: '',
    contentType: '',
    minViews: '',
    startDate: '',
    endDate: '',
    showArchived: false,
  });

  const loadCreatorTypes = useCallback(async () => {
    try {
      const { data } = await getCreators();
      const map = {};
      for (const c of data) {
        if (c.content_type) map[c.account_handle] = c.content_type;
      }
      setCreatorTypes(map);
    } catch {}
  }, []);

  const loadContent = useCallback(async () => {
    try {
      const params = { page, limit: 24 };
      if (filters.sort) params.sort = filters.sort;
      if (filters.tag) params.tag = filters.tag;
      if (filters.account) params.account = filters.account;
      if (filters.contentType) params.contentType = filters.contentType;
      if (filters.minViews) params.minViews = filters.minViews;
      if (filters.startDate) params.startDate = filters.startDate;
      if (filters.endDate) params.endDate = filters.endDate;
      if (filters.showArchived) params.showArchived = 'true';

      const { data } = await getContent(params);
      setPosts(data.posts);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setAccounts(data.accounts || []);
    } catch (err) {
      console.error('Failed to load content:', err);
    }
  }, [page, filters]);

  useEffect(() => {
    loadContent();
    loadCreatorTypes();
  }, [loadContent, loadCreatorTypes]);

  const handleFilterChange = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  const handleUpdate = () => {
    loadContent();
    loadCreatorTypes();
  };

  const handleImport = async () => {
    const urls = importText
      .split(/[\n,]+/)
      .map(u => u.trim())
      .filter(u => u.startsWith('http'));
    if (urls.length === 0) return alert('Paste at least one Instagram URL');
    if (urls.length > 20) return alert('Max 20 URLs at a time');
    setImporting(true);
    setImportResult(null);
    try {
      const { data } = await importUrls(urls);
      setImportResult(data);
      setImportText('');
      loadContent();
    } catch (err) {
      setImportResult({ error: err.response?.data?.error || err.message });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Import Bar */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setShowImport(!showImport)}
          className="px-4 py-2 bg-gray-800 border border-gray-700 text-gray-300 text-sm rounded-lg hover:bg-gray-700 transition-colors"
        >
          {showImport ? 'Close Import' : 'Import by URL'}
        </button>
        {importResult && !importResult.error && (
          <span className="text-sm text-emerald-400">Imported {importResult.imported} of {importResult.scraped || importResult.total} posts</span>
        )}
        {importResult?.error && (
          <span className="text-sm text-red-400">{importResult.error}</span>
        )}
      </div>

      {showImport && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
          <p className="text-sm text-gray-400">Paste Instagram reel/post URLs (one per line, max 20)</p>
          <textarea
            value={importText}
            onChange={e => setImportText(e.target.value)}
            rows={4}
            placeholder={"https://www.instagram.com/reel/ABC123/\nhttps://www.instagram.com/p/XYZ789/"}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:border-gold focus:outline-none resize-none"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handleImport}
              disabled={importing || !importText.trim()}
              className="px-4 py-2 bg-gold text-gray-950 rounded-lg font-medium text-sm hover:bg-gold/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {importing ? 'Importing...' : `Import ${importText.split(/[\n,]+/).filter(u => u.trim().startsWith('http')).length || 0} URL(s)`}
            </button>
            <span className="text-xs text-gray-500">Uses 1 Apify run for all URLs</span>
          </div>
        </div>
      )}

      <FilterBar
        filters={filters}
        accounts={accounts}
        total={total}
        onChange={handleFilterChange}
        onExport={() => exportContent('json')}
      />

      {posts.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-500 text-lg">No content found.</p>
          <p className="text-gray-600 text-sm mt-1">Try adjusting your filters or scrape some content first.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {posts.map((post) => (
            <ContentCard key={post.id} post={post} creatorTypes={creatorTypes} onUpdate={handleUpdate} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-30"
          >
            Previous
          </button>
          <span className="text-sm text-gray-400">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
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
