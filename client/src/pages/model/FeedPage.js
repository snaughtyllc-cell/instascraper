import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getMyAssignments, getMyFeed, getMySaves, saveMyPost, sendMyPostFeedback, unsaveMyPost } from '../../api';
import ReelCard from '../../components/ReelCard';
import useActiveInView from '../../hooks/useActiveInView';

function samePost(left, right) {
  return String(left?.id ?? left?.shortcode) === String(right?.id ?? right?.shortcode);
}

function restoreAt(items, item, index) {
  if (items.some((candidate) => samePost(candidate, item))) return items;
  const next = [...items];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
  return next;
}

function mergeRevalidatedPosts(current, incoming) {
  const freshById = new Map(incoming.map((post) => [String(post.id ?? post.shortcode), post]));
  const kept = current
    .map((post) => freshById.get(String(post.id ?? post.shortcode)))
    .filter(Boolean);
  const keptIds = new Set(kept.map((post) => String(post.id ?? post.shortcode)));
  return [...kept, ...incoming.filter((post) => !keptIds.has(String(post.id ?? post.shortcode)))];
}

function requestError(err, fallback) {
  if (err.code === 'ECONNABORTED') return 'This is taking longer than expected. Try again.';
  return err.response?.data?.error || fallback;
}

export default function FeedPage({ active = true }) {
  const [posts, setPosts] = useState([]);
  const [assignedPosts, setAssignedPosts] = useState([]);
  const [availableNiches, setAvailableNiches] = useState([]);
  const [activeNiche, setActiveNiche] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [pendingIds, setPendingIds] = useState(new Set());
  const [savedIds, setSavedIds] = useState(new Set());
  const [feedbackByPost, setFeedbackByPost] = useState({});
  const [soundOn, setSoundOn] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showTop, setShowTop] = useState(false);
  const requestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const refreshRequestedRef = useRef(false);

  const playbackPosts = useMemo(() => [...assignedPosts, ...posts], [assignedPosts, posts]);
  const { autoplayInView, activeCardId, registerRef } = useActiveInView(playbackPosts);

  const loadFeed = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const blocking = !hasLoadedRef.current;
    const shuffle = refreshRequestedRef.current;
    if (blocking) setLoading(true);
    setError('');
    try {
      const { data } = await getMyFeed(page, activeNiche || undefined, { refresh: shuffle });
      if (requestId !== requestIdRef.current) return;
      const incomingPosts = data.posts || [];
      setPosts((current) => blocking ? incomingPosts : mergeRevalidatedPosts(current, incomingPosts));
      const allowed = new Set(data.niches || []);
      setAvailableNiches((data.availableNiches || []).filter((niche) => allowed.has(niche.value)));
      setHasMore(Boolean(data.hasMore));
      hasLoadedRef.current = true;
      refreshRequestedRef.current = false;
    } catch (err) {
      console.error('Failed to load feed:', err);
      if (requestId === requestIdRef.current) {
        const message = requestError(err, 'We could not load your feed.');
        if (hasLoadedRef.current) setActionError(message);
        else {
          setError(message);
          setHasMore(false);
        }
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [page, activeNiche, refreshKey]);

  const loadAssignments = useCallback(async () => {
    try {
      const { data } = await getMyAssignments();
      const assigned = data.posts || [];
      setAssignedPosts(assigned);
      const feedbackMap = {};
      for (const post of assigned) {
        if (post.feedback) feedbackMap[post.id] = post.feedback;
      }
      setFeedbackByPost(feedbackMap);
    } catch (err) {
      console.error('Failed to load assignments:', err);
      setActionError(requestError(err, 'We could not load the reels picked for you.'));
    }
  }, []);

  const loadSaves = useCallback(async () => {
    try {
      const { data } = await getMySaves();
      setSavedIds(new Set((data.posts || []).map((p) => p.id)));
    } catch (err) {
      console.error('Failed to load saves:', err);
      setActionError(requestError(err, 'We could not check your saved reels.'));
    }
  }, []);

  useEffect(() => {
    if (active) loadFeed();
  }, [active, loadFeed]);

  useEffect(() => {
    if (active) loadAssignments();
  }, [active, loadAssignments]);

  useEffect(() => {
    if (active) loadSaves();
  }, [active, loadSaves]);

  useEffect(() => {
    if (!active) {
      setShowTop(false);
      return undefined;
    }
    const onScroll = () => setShowTop(window.scrollY > 520);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [active]);

  const handleToggleSave = async (post) => {
    if (pendingIds.has(post.id)) return;
    const isSaved = savedIds.has(post.id);
    const previousFeedback = feedbackByPost[post.id];
    setActionError('');
    setPendingIds((prev) => new Set(prev).add(post.id));
    setSavedIds((prev) => {
      const next = new Set(prev);
      isSaved ? next.delete(post.id) : next.add(post.id);
      return next;
    });
    setFeedbackByPost((map) => {
      const next = { ...map };
      if (!isSaved) next[post.id] = 'want_to_make';
      else if (next[post.id] === 'want_to_make') delete next[post.id];
      return next;
    });
    try {
      if (isSaved) await unsaveMyPost(post.id);
      else {
        await saveMyPost(post.id);
        setAssignedPosts((current) => current.filter((candidate) => !samePost(candidate, post)));
      }
    } catch (err) {
      console.error('Failed to toggle save:', err);
      setActionError(requestError(err, `We could not ${isSaved ? 'remove' : 'save'} that reel. Try again.`));
      setSavedIds((prev) => {
        const next = new Set(prev);
        isSaved ? next.add(post.id) : next.delete(post.id);
        return next;
      });
      setFeedbackByPost((map) => {
        const next = { ...map };
        if (previousFeedback) next[post.id] = previousFeedback;
        else delete next[post.id];
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

  const handleNotInterested = async (post) => {
    if (pendingIds.has(post.id)) return;
    const prevFeedback = feedbackByPost[post.id];
    const wasSaved = savedIds.has(post.id);
    const postIndex = posts.findIndex((candidate) => samePost(candidate, post));
    const assignedIndex = assignedPosts.findIndex((candidate) => samePost(candidate, post));
    setActionError('');
    setPendingIds((prev) => new Set(prev).add(post.id));
    setFeedbackByPost((map) => ({ ...map, [post.id]: 'not_my_style' }));
    setPosts((current) => current.filter((candidate) => !samePost(candidate, post)));
    setAssignedPosts((current) => current.filter((candidate) => !samePost(candidate, post)));
    setSavedIds((prev) => {
      const next = new Set(prev);
      next.delete(post.id);
      return next;
    });
    try {
      await sendMyPostFeedback(post.id, 'not_my_style');
    } catch (err) {
      console.error('Failed to mark not interested:', err);
      setActionError(requestError(err, 'We could not hide that reel. Try again.'));
      if (postIndex >= 0) setPosts((current) => restoreAt(current, post, postIndex));
      if (assignedIndex >= 0) setAssignedPosts((current) => restoreAt(current, post, assignedIndex));
      setFeedbackByPost((map) => {
        const next = { ...map };
        if (prevFeedback) next[post.id] = prevFeedback;
        else delete next[post.id];
        return next;
      });
      if (wasSaved) setSavedIds((prev) => new Set(prev).add(post.id));
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(post.id);
        return next;
      });
    }
  };

  const selectNiche = (value) => {
    refreshRequestedRef.current = false;
    hasLoadedRef.current = false;
    setPosts([]);
    setLoading(true);
    setActiveNiche(value);
    setPage(1);
    setRefreshKey(0);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const refreshFeed = () => {
    refreshRequestedRef.current = true;
    hasLoadedRef.current = false;
    setPosts([]);
    setLoading(true);
    setPage(1);
    setRefreshKey((key) => key + 1);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const goToPage = (nextPage) => {
    refreshRequestedRef.current = false;
    hasLoadedRef.current = false;
    setPosts([]);
    setLoading(true);
    setRefreshKey(0);
    setPage(nextPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const chipClass = (on) =>
    `shrink-0 px-3.5 py-1.5 rounded-full border text-[12px] font-bold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-model-coral/50 ${
      on ? 'border-model-ink bg-model-ink text-white' : 'border-model-line bg-model-surface text-model-ink hover:border-model-muted'
    }`;

  return (
    <div className="px-3 pt-3 pb-4 space-y-4">
      {actionError && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-800" role="alert">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError('')} className="shrink-0 font-bold" aria-label="Dismiss error">X</button>
        </div>
      )}
      {assignedPosts.length > 0 && (
        <section className="space-y-3">
          <div className="px-1">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-model-coral-ink">Picked for you</p>
            <p className="mt-0.5 text-xs font-medium text-model-muted">Selected by your team</p>
          </div>
          <div className="flex flex-col gap-4">
            {assignedPosts.map((post) => (
              <ReelCard
                key={`assigned-${post.id}`}
                post={post}
                autoplayInView={autoplayInView}
                isActive={String(post.id ?? post.shortcode) === activeCardId}
                soundOn={soundOn}
                onToggleSound={() => setSoundOn((s) => !s)}
                registerRef={registerRef}
                onToggleSave={handleToggleSave}
                isSaved={savedIds.has(post.id)}
                feedback={feedbackByPost[post.id]}
                onNotInterested={handleNotInterested}
                actionPending={pendingIds.has(post.id)}
                pageActive={active}
              />
            ))}
          </div>
        </section>
      )}

      <div className="flex items-center gap-2">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-1 -mx-1">
          <button onClick={() => selectNiche(null)} aria-pressed={activeNiche === null} className={chipClass(activeNiche === null)}>
            Explore
          </button>
          {availableNiches.map((n) => (
            <button key={n.value} onClick={() => selectNiche(n.value)} aria-pressed={activeNiche === n.value} className={chipClass(activeNiche === n.value)}>
              {n.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={refreshFeed}
          disabled={loading}
          className="shrink-0 w-10 h-10 rounded-full border border-model-line bg-model-surface text-model-ink shadow-sm flex items-center justify-center hover:bg-model-butter disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-model-coral/50"
          title="Refresh feed"
          aria-label="Refresh feed"
        >
          <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6M5.64 18.36A9 9 0 0018.36 5.64M18.36 18.36A9 9 0 005.64 5.64" />
          </svg>
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-model-muted">
          <svg className="w-6 h-6 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading…
        </div>
      ) : error ? (
        <div className="mx-1 rounded-lg border border-red-200 bg-red-50 px-6 py-12 text-center" role="alert">
          <p className="text-base font-bold text-model-ink">Feed did not load</p>
          <p className="mt-1.5 text-sm text-model-muted">{error}</p>
          <button
            type="button"
            onClick={loadFeed}
            className="mt-4 min-h-[44px] rounded-lg bg-model-ink px-5 text-sm font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-model-coral/50 focus-visible:ring-offset-2"
          >
            Try again
          </button>
        </div>
      ) : posts.length === 0 ? (
        <div className="mx-1 rounded-lg border border-model-line bg-model-surface px-6 py-16 text-center shadow-sm">
          <p className="text-model-ink text-base font-bold">No reels ready yet</p>
          <p className="text-model-muted text-sm mt-1.5">Fresh reels for this niche are still processing.</p>
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
              feedback={feedbackByPost[post.id]}
              onNotInterested={handleNotInterested}
              actionPending={pendingIds.has(post.id)}
              pageActive={active}
            />
          ))}
        </div>
      )}

      {(posts.length > 0 || page > 1) && !loading && !error && (
        <div className="flex items-center justify-center gap-3 pt-3 pb-4">
          <button
            onClick={() => goToPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="min-h-[44px] px-5 flex items-center justify-center rounded-lg border border-model-line text-sm font-semibold text-model-ink bg-model-surface hover:bg-white disabled:opacity-30"
          >
            Previous
          </button>
          <span className="text-sm font-medium text-model-muted">Page {page}</span>
          <button
            onClick={() => goToPage(page + 1)}
            disabled={!hasMore}
            className="min-h-[44px] px-5 flex items-center justify-center rounded-lg border border-model-line text-sm font-semibold text-model-ink bg-model-surface hover:bg-white disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}

      {showTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-24 right-4 z-40 h-11 w-11 rounded-full border border-model-line bg-model-surface/95 text-model-ink shadow-lg shadow-model-ink/10 backdrop-blur flex items-center justify-center hover:bg-model-butter"
          title="Back to top"
          aria-label="Back to top"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}
