import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getMyIdeas } from '../../api';
import ContentCard from '../../components/ContentCard';
import useActiveInView from '../../hooks/useActiveInView';

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function IdeasPage() {
  const [ideas, setIdeas] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadIdeas = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getMyIdeas();
      setIdeas(data.ideas || []);
    } catch (err) {
      console.error('Failed to load ideas:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadIdeas();
  }, [loadIdeas]);

  // Shared autoplay-in-view observer across every source reel on the page
  // (mirrors FeedPage), so at most one reel plays at a time as the model
  // scrolls through idea cards.
  const allReels = useMemo(() => ideas.flatMap((i) => i.sourceReels || []), [ideas]);
  const { autoplayInView, activeCardId, registerRef } = useActiveInView(allReels);

  return (
    <div className="px-4 py-5 space-y-5">
      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-500">
          <svg className="w-6 h-6 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading…
        </div>
      ) : ideas.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-400 text-base">No ideas yet.</p>
          <p className="text-gray-600 text-sm mt-1.5">Content ideas built from trending reels in your niche will show up here.</p>
        </div>
      ) : (
        ideas.map((idea) => (
          <div key={idea.id} className="bg-gray-900 rounded-2xl border border-gray-800/80 p-5 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-base font-semibold text-white leading-snug">{idea.concept}</h3>
              {idea.format && (
                <span className="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium bg-gold/20 text-gold border border-gold/40">
                  {idea.format}
                </span>
              )}
            </div>

            {idea.hook_line && (
              <p className="text-sm text-gray-300 italic leading-relaxed">&ldquo;{idea.hook_line}&rdquo;</p>
            )}

            {idea.why_working && (
              <p className="text-xs text-gray-400 leading-relaxed">{idea.why_working}</p>
            )}

            {idea.stale_warning && (
              <p className="text-xs text-yellow-500">{idea.stale_warning}</p>
            )}

            {idea.sourceReels?.length > 0 && (
              <div className="pt-2 space-y-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Reels that inspired this</p>
                <div className="grid grid-cols-3 gap-2.5">
                  {idea.sourceReels.map((reel) => (
                    <ContentCard
                      key={`${idea.id}-${reel.id}`}
                      post={reel}
                      variant="feed"
                      autoplayInView={autoplayInView}
                      isActive={String(reel.id ?? reel.shortcode) === activeCardId}
                      registerRef={registerRef}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between pt-3 mt-1 border-t border-gray-800/60">
              {idea.source_niche && (
                <span className="text-xs text-gray-600">{idea.source_niche}</span>
              )}
              <span className="text-xs text-gray-600">{formatDate(idea.created_at)}</span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
