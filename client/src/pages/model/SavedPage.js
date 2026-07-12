import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getMySaves, unsaveMyPost } from '../../api';
import ReelCard from '../../components/ReelCard';
import useActiveInView from '../../hooks/useActiveInView';

function requestError(err, fallback) {
  if (err.code === 'ECONNABORTED') return 'This is taking longer than expected. Try again.';
  return err.response?.data?.error || fallback;
}

export default function SavedPage({ active = true, onExplore }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pendingIds, setPendingIds] = useState(new Set());
  const [soundOn, setSoundOn] = useState(false);
  const hasLoadedRef = useRef(false);

  const { autoplayInView, activeCardId, registerRef } = useActiveInView(posts);

  const loadSaves = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    setError('');
    try {
      const { data } = await getMySaves();
      setPosts(data.posts || []);
      hasLoadedRef.current = true;
    } catch (err) {
      console.error('Failed to load saved posts:', err);
      const message = requestError(err, 'We could not load your saved reels.');
      if (hasLoadedRef.current) setActionError(message);
      else setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) loadSaves();
  }, [active, loadSaves]);

  const handleUnsave = async (post) => {
    if (pendingIds.has(post.id)) return;
    const index = posts.findIndex((candidate) => candidate.id === post.id);
    setActionError('');
    setPendingIds((prev) => new Set(prev).add(post.id));
    setPosts((prev) => prev.filter((p) => p.id !== post.id));
    try {
      await unsaveMyPost(post.id);
    } catch (err) {
      console.error('Failed to unsave post:', err);
      setActionError(requestError(err, 'We could not remove that reel. Try again.'));
      setPosts((current) => {
        if (current.some((candidate) => candidate.id === post.id)) return current;
        const next = [...current];
        next.splice(Math.max(0, Math.min(index, next.length)), 0, post);
        return next;
      });
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(post.id);
        return next;
      });
    }
  };

  return (
    <div className="px-3 pt-3 pb-4 space-y-4">
      {actionError && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-800" role="alert">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError('')} className="shrink-0 font-bold" aria-label="Dismiss error">X</button>
        </div>
      )}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-model-muted">
          <svg className="w-6 h-6 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-6 py-12 text-center" role="alert">
          <p className="text-base font-bold text-model-ink">Saved reels did not load</p>
          <p className="mt-1.5 text-sm text-model-muted">{error}</p>
          <button type="button" onClick={loadSaves} className="mt-4 min-h-[44px] rounded-lg bg-model-ink px-5 text-sm font-bold text-white">
            Try again
          </button>
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
          {onExplore && (
            <button type="button" onClick={onExplore} className="mt-4 min-h-[44px] rounded-lg bg-model-ink px-5 text-sm font-bold text-white">
              Explore reels
            </button>
          )}
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
              actionPending={pendingIds.has(post.id)}
              pageActive={active}
            />
          ))}
          </div>
        </>
      )}
    </div>
  );
}
