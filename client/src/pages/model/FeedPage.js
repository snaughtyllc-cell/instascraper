import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
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

export default function FeedPage({ active = true, resetSignal = 0 }) {
  const [posts, setPosts] = useState([]);
  const [assignedPosts, setAssignedPosts] = useState([]);
  const [availableNiches, setAvailableNiches] = useState([]);
  const [activeNiche, setActiveNiche] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [assignmentsReady, setAssignmentsReady] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [pendingIds, setPendingIds] = useState(new Set());
  const [savedIds, setSavedIds] = useState(new Set());
  const [feedbackByPost, setFeedbackByPost] = useState({});
  const [soundOn, setSoundOn] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const requestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const refreshRequestedRef = useRef(false);
  const scrollerRef = useRef(null);
  const pendingSnapIndexRef = useRef(null);
  const keySnapTimerRef = useRef(null);

  const playbackPosts = useMemo(() => {
    const assignedIds = new Set(assignedPosts.map((post) => String(post.id ?? post.shortcode)));
    return [
      ...assignedPosts.map((post) => ({ ...post, pickedForYou: true })),
      ...posts.filter((post) => !assignedIds.has(String(post.id ?? post.shortcode))),
    ];
  }, [assignedPosts, posts]);
  const { autoplayInView, activeCardId, registerRef } = useActiveInView(playbackPosts, {
    rootRef: scrollerRef,
    forceAutoplay: true,
  });

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
    } finally {
      setAssignmentsReady(true);
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
    if (resetSignal > 0) scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [resetSignal]);

  useEffect(() => () => window.clearTimeout(keySnapTimerRef.current), []);

  useLayoutEffect(() => {
    if (!scrollerRef.current) return;
    const slides = scrollerRef.current.querySelectorAll('[data-reel-slide]');
    if (pendingSnapIndexRef.current != null) {
      const nextIndex = Math.min(pendingSnapIndexRef.current, Math.max(0, slides.length - 1));
      pendingSnapIndexRef.current = null;
      if (slides[nextIndex]) scrollerRef.current.scrollTo({ top: slides[nextIndex].offsetTop, behavior: 'auto' });
      return;
    }
    if (!activeCardId) return;
    const activeSlide = Array.from(slides).find((slide) => slide.dataset.reelId === activeCardId);
    if (activeSlide) scrollerRef.current.scrollTo({ top: activeSlide.offsetTop, behavior: 'auto' });
  }, [playbackPosts, active, activeCardId]);

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
    pendingSnapIndexRef.current = playbackPosts.findIndex((candidate) => samePost(candidate, post));
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
    setAnnouncement(`Reel by @${post.account_handle || 'creator'} hidden. Showing the next reel.`);
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
    scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const refreshFeed = () => {
    refreshRequestedRef.current = true;
    hasLoadedRef.current = false;
    setPosts([]);
    setLoading(true);
    setPage(1);
    setRefreshKey((key) => key + 1);
    scrollerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  };

  const goToPage = (nextPage) => {
    refreshRequestedRef.current = false;
    hasLoadedRef.current = false;
    setPosts([]);
    setLoading(true);
    setRefreshKey(0);
    setPage(nextPage);
    scrollerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleFeedKeyDown = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key)) return;
    const slides = Array.from(scrollerRef.current?.querySelectorAll('[data-reel-slide]') || []);
    if (!slides.length) return;
    event.preventDefault();
    const activeIndex = Math.max(0, playbackPosts.findIndex((post) => String(post.id ?? post.shortcode) === activeCardId));
    const direction = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
    const nextSlide = slides[Math.max(0, Math.min(slides.length - 1, activeIndex + direction))];
    if (nextSlide) {
      const top = nextSlide.offsetTop;
      requestAnimationFrame(() => scrollerRef.current?.scrollTo({ top, behavior: 'smooth' }));
      window.clearTimeout(keySnapTimerRef.current);
      keySnapTimerRef.current = window.setTimeout(() => {
        scrollerRef.current?.scrollTo({ top, behavior: 'auto' });
      }, 450);
    }
  };

  const chipClass = (on) =>
    `shrink-0 px-3.5 py-1.5 rounded-full border text-[12px] font-bold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-model-coral/50 ${
      on ? 'border-model-ink bg-model-ink text-white' : 'border-model-line bg-model-surface text-model-ink hover:border-model-muted'
    }`;

  return (
    <div className="relative h-full min-h-0 bg-black">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-black/75 via-black/30 to-transparent px-3 pb-8 pt-3">
        <div className="pointer-events-auto flex items-center gap-2">
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          <button onClick={() => selectNiche(null)} aria-pressed={activeNiche === null} className={chipClass(activeNiche === null)}>
            Explore
          </button>
          {availableNiches.map((n) => (
            <button key={n.value} onClick={() => selectNiche(n.value)} aria-pressed={activeNiche === n.value} className={chipClass(activeNiche === n.value)}>
              {n.label}
            </button>
          ))}
          </div>
          {(page > 1 || hasMore) && (
            <div className="flex h-10 shrink-0 items-center rounded-full border border-white/25 bg-model-surface/95 shadow-sm backdrop-blur">
              <button type="button" onClick={() => goToPage(Math.max(1, page - 1))} disabled={page === 1 || loading} className="h-10 w-9 disabled:opacity-30" aria-label="Previous feed page">‹</button>
              <span className="text-[11px] font-bold text-model-ink" aria-label={`Page ${page}`}>{page}</span>
              <button type="button" onClick={() => goToPage(page + 1)} disabled={!hasMore || loading} className="h-10 w-9 disabled:opacity-30" aria-label="Next feed page">›</button>
            </div>
          )}
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
      </div>

      <div className="sr-only" aria-live="polite">{announcement}</div>

      {actionError && (
        <div className="absolute inset-x-3 bottom-3 z-40 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-800 shadow-lg" role="alert">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError('')} className="shrink-0 font-bold" aria-label="Dismiss error">X</button>
        </div>
      )}

      {loading || !assignmentsReady ? (
        <div className="flex h-full items-center justify-center bg-model-canvas text-model-muted">
          <svg className="w-6 h-6 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading…
        </div>
      ) : error ? (
        <div className="flex h-full flex-col items-center justify-center bg-model-canvas px-6 text-center" role="alert">
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
      ) : playbackPosts.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center bg-model-canvas px-6 text-center">
          <p className="text-model-ink text-base font-bold">No reels ready yet</p>
          <p className="text-model-muted text-sm mt-1.5">Fresh reels for this niche are still processing.</p>
        </div>
      ) : (
        <div
          ref={scrollerRef}
          className="model-reel-scroller h-full min-h-0 overflow-y-auto bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-model-coral"
          tabIndex={0}
          onKeyDownCapture={handleFeedKeyDown}
          aria-label="Reels feed. Swipe or use the arrow keys for the next reel."
        >
          {playbackPosts.map((post, index) => (
            <div
              key={post.id ?? post.shortcode}
              data-reel-slide
              data-reel-id={String(post.id ?? post.shortcode)}
              className="h-full min-h-full snap-start snap-always"
            >
              <ReelCard
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
                reelMode
                pickedForYou={post.pickedForYou}
                accessiblePosition={`${index + 1} of ${playbackPosts.length}`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
