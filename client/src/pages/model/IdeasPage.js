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
        <div className="flex items-center justify-center py-20 text-model-muted">
          <svg className="w-6 h-6 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading…
        </div>
      ) : ideas.length === 0 ? (
        <div className="rounded-lg border border-model-line bg-model-surface px-6 py-16 text-center shadow-sm">
          <div className="mx-auto mb-4 h-11 w-11 rounded-full bg-model-sage flex items-center justify-center text-model-ink">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0c-.712.712-1.293 1.63-1.293 2.657a2 2 0 01-2 2h-.5a2 2 0 01-2-2c0-1.027-.581-1.945-1.293-2.657z" />
            </svg>
          </div>
          <p className="text-model-ink text-base font-bold">No ideas yet</p>
          <p className="text-model-muted text-sm mt-1.5">New concepts built from your niche will show up here.</p>
        </div>
      ) : (
        ideas.map((idea) => (
          <article key={idea.id} className="bg-model-surface rounded-lg border border-model-line p-4 shadow-[0_6px_18px_rgba(32,33,31,0.06)]">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              {idea.format && (
                <span className="rounded-full bg-model-butter border border-model-ink/10 px-2.5 py-0.5 text-[10px] font-bold text-model-ink">
                  {idea.format}
                </span>
              )}
              <span className="ml-auto text-[11px] font-medium text-model-muted">{formatDate(idea.created_at)}</span>
            </div>

            <p className="text-[16px] font-extrabold leading-snug text-model-ink">{idea.concept}</p>

            {idea.hook_line && (
              <p className="mt-2 border-l-2 border-model-coral pl-3 text-[13px] font-medium italic text-model-ink/80 leading-snug">&ldquo;{idea.hook_line}&rdquo;</p>
            )}

            {idea.why_working && (
              <p className="mt-2 text-xs text-model-muted leading-relaxed line-clamp-2">{idea.why_working}</p>
            )}

            {idea.stale_warning && (
              <p className="mt-2 text-xs font-semibold text-[#9B6B18]">{idea.stale_warning}</p>
            )}

            {idea.sourceReels?.length > 0 && (
              <div className="mt-3.5">
                <p className="mb-2 text-[10px] font-extrabold uppercase tracking-[0.12em] text-model-muted">Reels that inspired this</p>
                <div className="grid grid-cols-2 gap-2.5">
                  {idea.sourceReels.slice(0, 4).map((reel) => (
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
