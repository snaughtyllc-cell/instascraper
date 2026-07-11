import React, { useState, useEffect, useCallback } from 'react';
import { getMyAssignments, getMyFeed, getMySaves, saveMyPost, sendMyPostFeedback, unsaveMyPost } from '../../api';
import ReelCard from '../../components/ReelCard';
import useActiveInView from '../../hooks/useActiveInView';

export default function FeedPage() {
  const [posts, setPosts] = useState([]);
  const [assignedPosts, setAssignedPosts] = useState([]);
  const [availableNiches, setAvailableNiches] = useState([]);
  const [activeNiche, setActiveNiche] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [savedIds, setSavedIds] = useState(new Set());
  const [feedbackByPost, setFeedbackByPost] = useState({});
  const [soundOn, setSoundOn] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showTop, setShowTop] = useState(false);

  const playbackPosts = [...assignedPosts, ...posts];
  const { autoplayInView, activeCardId, registerRef } = useActiveInView(playbackPosts);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getMyFeed(page, activeNiche || undefined, { refresh: refreshKey > 0 });
      setPosts(data.posts || []);
      setAvailableNiches(data.availableNiches || []);
    } catch (err) {
      console.error('Failed to load feed:', err);
    } finally {
      setLoading(false);
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
    }
  }, []);

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
    loadAssignments();
  }, [loadAssignments]);

  useEffect(() => {
    loadSaves();
  }, [loadSaves]);

  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 520);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleToggleSave = async (post) => {
    const isSaved = savedIds.has(post.id);
    const previousFeedback = feedbackByPost[post.id];
    // Optimistic update — flip the set immediately, revert on failure.
    setSavedIds((prev) => {
      const next = new Set(prev);
      isSaved ? next.delete(post.id) : next.add(post.id);
      return next;
    });
    if (!isSaved) setFeedbackByPost((map) => ({ ...map, [post.id]: 'want_to_make' }));
    try {
      if (isSaved) await unsaveMyPost(post.id);
      else {
        await saveMyPost(post.id);
        await sendMyPostFeedback(post.id, 'want_to_make');
      }
    } catch (err) {
      console.error('Failed to toggle save:', err);
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
    }
  };

  const handleNotInterested = async (post) => {
    const prevFeedback = feedbackByPost[post.id];
    const wasSaved = savedIds.has(post.id);
    setFeedbackByPost((map) => ({ ...map, [post.id]: 'not_my_style' }));
    setSavedIds((prev) => {
      const next = new Set(prev);
      next.delete(post.id);
      return next;
    });
    try {
      await sendMyPostFeedback(post.id, 'not_my_style');
      if (wasSaved) await unsaveMyPost(post.id);
    } catch (err) {
      console.error('Failed to mark not interested:', err);
      setFeedbackByPost((map) => {
        const next = { ...map };
        if (prevFeedback) next[post.id] = prevFeedback;
        else delete next[post.id];
        return next;
      });
      if (wasSaved) setSavedIds((prev) => new Set(prev).add(post.id));
    }
  };

  const selectNiche = (value) => {
    setActiveNiche(value);
    setPage(1);
    setRefreshKey(0);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const refreshFeed = () => {
    setPage(1);
    setRefreshKey((key) => key + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const goToPage = (nextPage) => {
    setRefreshKey(0);
    setPage(nextPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const chipClass = (on) =>
    `shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-semibold whitespace-nowrap transition-colors ${
      on ? 'bg-gold text-gray-950' : 'bg-gray-800/80 text-gray-400 border border-gray-700 hover:text-gray-200'
    }`;

  return (
    <div className="px-3 pt-3 pb-4 space-y-3">
      {assignedPosts.length > 0 && (
        <section className="space-y-3">
          <div className="px-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-gold">Picked for you</p>
            <p className="text-xs text-gray-500 mt-0.5">Save what fits. Tap X when it is not your style.</p>
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
              />
            ))}
          </div>
        </section>
      )}

      <div className="flex items-center gap-2">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-1 -mx-1">
          <button onClick={() => selectNiche(null)} className={chipClass(activeNiche === null)}>
            Explore
          </button>
          {availableNiches.map((n) => (
            <button key={n.value} onClick={() => selectNiche(n.value)} className={chipClass(activeNiche === n.value)}>
              {n.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={refreshFeed}
          disabled={loading}
          className="shrink-0 w-10 h-10 rounded-full border border-gray-700 bg-gray-800/90 text-gray-300 flex items-center justify-center hover:text-white hover:border-gray-500 disabled:opacity-50"
          title="Refresh feed"
          aria-label="Refresh feed"
        >
          <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6M5.64 18.36A9 9 0 0018.36 5.64M18.36 18.36A9 9 0 005.64 5.64" />
          </svg>
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
              feedback={feedbackByPost[post.id]}
              onNotInterested={handleNotInterested}
            />
          ))}
        </div>
      )}

      {posts.length > 0 && (
        <div className="flex items-center justify-center gap-3 pt-3 pb-4">
          <button
            onClick={() => goToPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="min-h-[44px] px-5 flex items-center justify-center rounded-lg text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-30"
          >
            Previous
          </button>
          <span className="text-sm text-gray-500">Page {page}</span>
          <button
            onClick={() => goToPage(page + 1)}
            disabled={posts.length < 24}
            className="min-h-[44px] px-5 flex items-center justify-center rounded-lg text-sm text-gray-300 bg-gray-800 hover:bg-gray-700 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}

      {showTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-24 right-4 z-40 h-11 w-11 rounded-full border border-gold/30 bg-gray-900/95 text-gold shadow-lg shadow-black/30 backdrop-blur flex items-center justify-center"
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
