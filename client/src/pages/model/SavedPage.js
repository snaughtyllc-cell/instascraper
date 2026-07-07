import React, { useState, useEffect, useCallback } from 'react';
import { getMySaves, unsaveMyPost } from '../../api';
import ContentCard from '../../components/ContentCard';
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
    <div className="px-4 py-5 space-y-6">
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
          <p className="text-gray-400 text-base">No saved reels yet.</p>
          <p className="text-gray-600 text-sm mt-1.5">Tap the heart on a reel in your Feed to save it here.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
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
              onToggleSave={handleUnsave}
              isSaved={true}
            />
          ))}
        </div>
      )}
    </div>
  );
}
