import React, { useState, useEffect, useCallback } from 'react';
import { getMySaves, unsaveMyPost } from '../../api';
import ReelCard from '../../components/ReelCard';
import useActiveInView from '../../hooks/useActiveInView';

export default function SavedPage() {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [soundOn, setSoundOn] = useState(false);

  const { autoplayInView, activeCardId, registerRef } = useActiveInView(posts);

  const loadSaves = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getMySaves();
      setPosts(data.posts || []);
    } catch (err) {
      console.error('Failed to load saved posts:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSaves();
  }, [loadSaves]);

  const handleUnsave = async (post) => {
    // Optimistic remove — this list only ever shows saved posts, so toggling
    // here always means "unsave and drop from view".
    setPosts((prev) => prev.filter((p) => p.id !== post.id));
    try {
      await unsaveMyPost(post.id);
    } catch (err) {
      console.error('Failed to unsave post:', err);
      loadSaves(); // reconcile with the server if the call failed
    }
  };

  return (
    <div className="px-3 pt-3 pb-4 space-y-4">
      {loading ? (
        <div className="flex items-center justify-center py-20 text-model-muted">
          <svg className="w-6 h-6 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading…
        </div>
      ) : posts.length === 0 ? (
        <div className="rounded-lg border border-model-line bg-model-surface px-6 py-16 text-center shadow-sm">
          <div className="mx-auto mb-4 h-11 w-11 rounded-full bg-model-butter flex items-center justify-center text-model-ink">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </div>
          <p className="text-model-ink text-base font-bold">Nothing saved yet</p>
          <p className="text-model-muted text-sm mt-1.5">Reels you save will collect here.</p>
        </div>
      ) : (
        <>
          <div className="px-1 text-xs font-bold text-model-muted">{posts.length} saved {posts.length === 1 ? 'reel' : 'reels'}</div>
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
              onToggleSave={handleUnsave}
              isSaved={true}
            />
          ))}
          </div>
        </>
      )}
    </div>
  );
}
