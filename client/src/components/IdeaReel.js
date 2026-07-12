import React, { useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/react';
import API_URL from '../api-base';

// Compact, tap-to-play source reel for the Ideas page. A reel-shaped (9:13)
// thumbnail with a play button; tapping swaps in the cached video. This is the
// lean alternative to rendering a full ContentCard per source reel — those
// stacked their whole stats/caption/action body under a short crop, which read
// as cramped and "smashed". Here the reel keeps its shape and the chrome is one
// line of view count + handle.

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

export default function IdeaReel({ reel, active = false, onPlay, pageActive = true }) {
  const [failed, setFailed] = useState(false);
  const [pausedByExit, setPausedByExit] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  const containerRef = useRef(null);
  const videoRef = useRef(null);

  const id = reel.id ?? reel.shortcode;
  const reelUrl = reel.post_url || (reel.shortcode ? `https://www.instagram.com/reel/${reel.shortcode}/` : null);
  const thumbnailSrc = id != null ? `${API_URL}/thumb/${id}` : reel.thumbnail_url;
  const videoSrc = id != null ? `${API_URL}/video/${id}` : reel.video_url;
  const playing = active && pageActive && documentVisible && !pausedByExit && !failed;

  useEffect(() => {
    const onVisibility = () => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (!active) setPausedByExit(false);
  }, [active]);

  useEffect(() => {
    if (!containerRef.current || !active || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.1) setPausedByExit(true);
    }, { threshold: [0, 0.1] });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [active]);

  useEffect(() => {
    if (!playing && videoRef.current && !videoRef.current.paused) videoRef.current.pause();
  }, [playing]);

  useEffect(() => { setFailed(false); }, [id]);

  return (
    <div className="min-w-0">
      <div ref={containerRef} className="relative aspect-[9/13] rounded-lg overflow-hidden bg-model-line ring-1 ring-model-ink/10">
        {playing && !failed ? (
          <video
            ref={videoRef}
            src={videoSrc}
            poster={thumbnailSrc}
            autoPlay
            playsInline
            muted
            controls
            className="absolute inset-0 w-full h-full object-cover"
            onError={() => {
              setFailed(true);
              Sentry.captureMessage('Model preview playback failed', { level: 'warning', tags: { surface: 'model-preview', post_id: String(id) } });
            }}
          />
        ) : (
          <>
            <img
              src={thumbnailSrc}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
              onError={(e) => {
                if (e.target.src !== reel.thumbnail_url && reel.thumbnail_url) e.target.src = reel.thumbnail_url;
              }}
            />
            {failed && reelUrl ? (
              <a
                href={reelUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/50 text-white text-[11px] font-semibold"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <rect x="3" y="3" width="18" height="18" rx="5" />
                  <circle cx="12" cy="12" r="3.6" />
                  <circle cx="17.4" cy="6.6" r="1" fill="currentColor" stroke="none" />
                </svg>
                Open on IG
              </a>
            ) : (
              <button
                onClick={() => { setPausedByExit(false); onPlay?.(); }}
                className="absolute inset-0 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-model-coral/60"
                aria-label="Play reel"
              >
                <span className="h-9 w-9 rounded-full bg-model-surface/90 text-model-ink shadow-lg flex items-center justify-center">
                  <svg className="w-4 h-4 ml-0.5 fill-current" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                </span>
              </button>
            )}
          </>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-bold text-model-muted">
        <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        {formatCount(reel.view_count)}
      </div>
      {reel.account_handle && (
        <div className="text-[11px] font-bold text-model-coral-ink truncate">@{reel.account_handle}</div>
      )}
    </div>
  );
}
