import React, { useState, useEffect, useCallback } from 'react';
import { getMyFeed, getMySaves, saveMyPost, unsaveMyPost } from '../../api';
import ReelCard from '../../components/ReelCard';
import useActiveInView from '../../hooks/useActiveInView';

export default function FeedPage() {
  const [posts, setPosts] = useState([]);
  const [availableNiches, setAvailableNiches] = useState([]);
  const [activeNiche, setActiveNiche] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [savedIds, setSavedIds] = useState(new Set());
  const [soundOn, setSoundOn] = useState(false);

  const { autoplayInView, activeCardId, registerRef } = useActiveInView(posts);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getMyFeed(page, activeNiche || undefined);
      setPosts(data.posts || []);
      setAvailableNiches(data.availableNiches || []);
    } catch (err) {
      console.error('Failed to load feed:', err);
    } finally {
      setLoading(false);
    }
  }, [page, activeNiche]);

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

  const selectNiche = (value) => {
    setActiveNiche(value);
    setPage(1);
  };

  const chipClass = (on) =>
    `shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-semibold whitespace-nowrap transition-colors ${
      on ? 'bg-gold text-gray-950' : 'bg-gray-800/80 text-gray-400 border border-gray-700 hover:text-gray-200'
    }`;

  return (
    <div className="px-3 pt-3 pb-4 space-y-3">
      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto px-1 -mx-1">
        <button onClick={() => selectNiche(null)} className={chipClass(activeNiche === null)}>
          My Feed
        </button>
        {availableNiches.map((n) => (
          <button key={n.value} onClick={() => selectNiche(n.value)} className={chipClass(activeNiche === n.value)}>
            {n.label}
          </button>
        ))}
        <button onClick={() => selectNiche('all')} className={chipClass(activeNiche === 'all')}>
          All
        </button>
      </div>

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
          <p className="text-gray-400 text-base">No reels ready yet.</p>
          <p className="text-gray-600 text-sm mt-1.5">Fresh reels for this niche are still processing — check back shortly.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {posts.map((post) => (
            <ReelCard
              key={post.id}
              post={post}
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
        <div className="flex items-center justify-center gap-3 pt-3 pb-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="min-h-[44px] px-5 flex items-center justify-center rounded-lg text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-30"
          >
            Previous
          </button>
          <span className="text-sm text-gray-500">Page {page}</span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={posts.length < 24}
            className="min-h-[44px] px-5 flex items-center justify-center rounded-lg text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
