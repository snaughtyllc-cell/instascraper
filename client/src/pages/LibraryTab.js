import React, { useState, useEffect, useCallback } from 'react';
import { getContent, getCreators, exportContent } from '../api';
import ContentCard from '../components/ContentCard';
import FilterBar from '../components/FilterBar';

export default function LibraryTab() {
  const [posts, setPosts] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [accounts, setAccounts] = useState([]);
  const [creatorTypes, setCreatorTypes] = useState({});
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

  return (
    <div className="space-y-6">
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
