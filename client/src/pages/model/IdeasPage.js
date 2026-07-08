import React, { useState, useEffect, useCallback } from 'react';
import { getMyIdeas } from '../../api';
import IdeaReel from '../../components/IdeaReel';

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

  return (
    <div className="px-3 py-3 space-y-3">
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
          <article key={idea.id} className="bg-gray-900 rounded-2xl border border-gray-800/70 p-4">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              {idea.format && (
                <span className="rounded-full bg-gold/15 border border-gold/30 px-2.5 py-0.5 text-[11px] font-semibold text-gold">
                  {idea.format}
                </span>
              )}
              <span className="ml-auto text-[11px] text-gray-500">{formatDate(idea.created_at)}</span>
            </div>

            <p className="text-[15px] font-semibold leading-snug text-white">{idea.concept}</p>

            {idea.hook_line && (
              <p className="mt-2 text-[13px] italic text-gray-400 leading-snug">&ldquo;{idea.hook_line}&rdquo;</p>
            )}

            {idea.why_working && (
              <p className="mt-2 text-xs text-gray-500 leading-relaxed line-clamp-2">{idea.why_working}</p>
            )}

            {idea.stale_warning && (
              <p className="mt-2 text-xs text-yellow-500">{idea.stale_warning}</p>
            )}

            {idea.sourceReels?.length > 0 && (
              <div className="mt-3.5">
                <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-gray-500">Reels that inspired this</p>
                <div className="flex gap-2.5">
                  {idea.sourceReels.slice(0, 3).map((reel) => (
                    <IdeaReel key={`${idea.id}-${reel.id ?? reel.shortcode}`} reel={reel} />
                  ))}
                </div>
              </div>
            )}
          </article>
        ))
      )}
    </div>
  );
}
