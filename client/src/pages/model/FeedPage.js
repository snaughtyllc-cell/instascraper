import React, { useState, useEffect, useCallback } from 'react';
import { getMyFeed, getMySaves, saveMyPost, unsaveMyPost } from '../../api';
import ContentCard from '../../components/ContentCard';
import useActiveInView from '../../hooks/useActiveInView';

export default function FeedPage() {
  const [posts, setPosts] = useState([]);
  const [niches, setNiches] = useState([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [savedIds, setSavedIds] = useState(new Set());
  const [soundOn, setSoundOn] = useState(false);

  const { autoplayInView, activeCardId, registerRef } = useActiveInView(posts);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getMyFeed(page);
      setPosts(data.posts || []);
      setNiches(data.niches || []);
    } catch (err) {
      console.error('Failed to load feed:', err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  const loadSaves = useCallback(async () => {
    try {
      const { data } = await getMySaves();
      setSavedIds(new Set((data.posts || []).map((p) => p.id)));
    } catch (err) {
      console.error('Failed to load saves:', err);
    }
  }, []);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  useEffect(() => {
    loadSaves();
  }, [loadSaves]);

  const handleToggleSave = async (post) => {
    const isSaved = savedIds.has(post.id);
    // Optimistic update — flip the set immediately, revert on failure.
    setSavedIds((prev) => {
      const next = new Set(prev);
      isSaved ? next.delete(post.id) : next.add(post.id);
      return next;
    });
    try {
      if (isSaved) await unsaveMyPost(post.id);
      else await saveMyPost(post.id);
    } catch (err) {
      console.error('Failed to toggle save:', err);
      setSavedIds((prev) => {
        const next = new Set(prev);
        isSaved ? next.add(post.id) : next.delete(post.id);
        return next;
      });
    }
  };

  return (
    <div className="px-3 py-4 space-y-4">
      {niches.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1">
          {niches.map((n) => (
            <span key={n} className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-800 text-gray-400 border border-gray-700">
              {n}
            </span>
          ))}
        </div>
      )}

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
          <p className="text-gray-500 text-lg">No content yet.</p>
          <p className="text-gray-600 text-sm mt-1">Check back soon — new reels for your niche land here.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {posts.map((post) => (
            <ContentCard
              key={post.id}
              post={post}
              variant="feed"
              autoplayInView={autoplayInView}
              isActive={String(post.id ?? post.shortcode) === activeCardId}
              soundOn={soundOn}
              onToggleSound={() => setSoundOn((s) => !s)}
              registerRef={registerRef}
              onToggleSave={handleToggleSave}
              isSaved={savedIds.has(post.id)}
            />
          ))}
        </div>
      )}

      {posts.length > 0 && (
        <div className="flex items-center justify-center gap-2 pt-2 pb-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-4 py-2 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-30"
          >
            Previous
          </button>
          <span className="text-sm text-gray-400">Page {page}</span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={posts.length < 24}
            className="px-4 py-2 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
