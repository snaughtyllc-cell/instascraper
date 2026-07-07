import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getContent, getCreators, exportContent, importUrls, bulkUpdateContent, getContentTypes, addContentType } from '../api';
import BulkActionBar from '../components/BulkActionBar';
import ContentCard from '../components/ContentCard';
import FilterBar from '../components/FilterBar';
import { daysAgoISO } from '../utils/date';

export default function LibraryTab() {
  const [posts, setPosts] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [accounts, setAccounts] = useState([]);
  const [creatorTypes, setCreatorTypes] = useState({});
  const [contentTypes, setContentTypes] = useState([]);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [filters, setFilters] = useState({
    sort: 'newest',
    search: '',
    tag: '',
    account: '',
    contentType: '',
    minViews: '',
    startDate: daysAgoISO(30), // default to the last 30 days so stale bangers don't dominate
    endDate: '',
    showArchived: false,
  });
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);

  const autoplayInView = typeof window !== 'undefined'
    && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const [activeCardId, setActiveCardId] = useState(null);
  const [soundOn, setSoundOn] = useState(false);
  const nodeMap = useRef(new Map());       // id -> DOM node
  const ratioMap = useRef(new Map());      // id -> intersectionRatio
  const observerRef = useRef(null);

  const registerRef = useCallback((id, node) => {
    if (!autoplayInView || !node) return;
    nodeMap.current.set(id, node);
    node.dataset.cardId = String(id);
    if (observerRef.current) observerRef.current.observe(node);
  }, [autoplayInView]);

  useEffect(() => {
    if (!autoplayInView) return;
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = e.target.dataset.cardId;
        ratioMap.current.set(id, e.isIntersecting ? e.intersectionRatio : 0);
      }
      let bestId = null, best = 0;
      for (const [id, r] of ratioMap.current.entries()) {
        if (r > best) { best = r; bestId = id; }
      }
      setActiveCardId(best >= 0.6 ? (isNaN(Number(bestId)) ? bestId : Number(bestId)) : null);
    }, { threshold: [0, 0.6, 1] });
    observerRef.current = obs;
    for (const node of nodeMap.current.values()) obs.observe(node);
    return () => obs.disconnect();
  }, [autoplayInView, posts]);

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

  const loadContentTypes = useCallback(async () => {
    try {
      const { data } = await getContentTypes();
      setContentTypes(data);
    } catch {}
  }, []);

  const handleAddContentType = useCallback(async (label) => {
    const { data } = await addContentType(label);
    await loadContentTypes();
    return data; // { value, label }
  }, [loadContentTypes]);

  const loadContent = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 24 };
      if (filters.sort) params.sort = filters.sort;
      if (filters.tag === '__untagged__') params.untagged = 'true';
      else if (filters.tag) params.tag = filters.tag;
      if (filters.search) params.search = filters.search;
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
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => {
    loadContent();
    loadCreatorTypes();
    loadContentTypes();
  }, [loadContent, loadCreatorTypes, loadContentTypes]);

  const handleFilterChange = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
    setSelected(new Set());
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const selectAllOnPage = () => setSelected(new Set(posts.map((p) => p.id)));
  const clearSelection = () => setSelected(new Set());

  const handleBulk = async (action, value) => {
    if (selected.size === 0) return;
    try {
      await bulkUpdateContent([...selected], action, value);
      clearSelection();
      loadContent();
      loadCreatorTypes();
    } catch (err) {
      console.error('Bulk action failed:', err);
      alert('Bulk action failed: ' + (err.response?.data?.error || err.message));
    }
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
        contentTypes={contentTypes}
        total={total}
        onChange={handleFilterChange}
        onExport={() => exportContent('json')}
      />

      <BulkActionBar
        count={selected.size}
        onTag={(t) => handleBulk('tag', t)}
        onArchive={(a) => handleBulk('archive', a)}
        onSetType={(ct) => handleBulk('content-type', ct)}
        onSelectAll={selectAllOnPage}
        onClear={clearSelection}
      />

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-500">
          <svg className="w-6 h-6 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading…
        </div>
      ) : posts.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-500 text-lg">No content found.</p>
          <p className="text-gray-600 text-sm mt-1">Try adjusting your filters or scrape some content first.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {posts.map((post) => (
            <ContentCard
              key={post.id}
              post={post}
              creatorTypes={creatorTypes}
              contentTypes={contentTypes}
              onAddContentType={handleAddContentType}
              onUpdate={handleUpdate}
              selected={selected.has(post.id)}
              onToggleSelect={toggleSelect}
              autoplayInView={autoplayInView}
              isActive={post.id === activeCardId}
              soundOn={soundOn}
              onToggleSound={() => setSoundOn((s) => !s)}
              registerRef={registerRef}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <button onClick={() => { setPage((p) => Math.max(1, p - 1)); setSelected(new Set()); }} disabled={page === 1} className="px-3 py-1.5 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-30">Previous</button>
          <span className="text-sm text-gray-400">
            Page {page} of {totalPages}
          </span>
          <button onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setSelected(new Set()); }} disabled={page === totalPages} className="px-3 py-1.5 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-30">Next</button>
        </div>
      )}
    </div>
  );
}
