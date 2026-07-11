import React, { useState } from 'react';

// Compact, tap-to-play source reel for the Ideas page. A reel-shaped (9:13)
// thumbnail with a play button; tapping swaps in the cached video. This is the
// lean alternative to rendering a full ContentCard per source reel — those
// stacked their whole stats/caption/action body under a short crop, which read
// as cramped and "smashed". Here the reel keeps its shape and the chrome is one
// line of view count + handle.

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:4000';

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

export default function IdeaReel({ reel }) {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  const id = reel.id ?? reel.shortcode;
  const reelUrl = reel.post_url || (reel.shortcode ? `https://www.instagram.com/reel/${reel.shortcode}/` : null);
  const thumbnailSrc = id != null ? `${API_URL}/thumb/${id}` : reel.thumbnail_url;
  const videoSrc = id != null ? `${API_URL}/video/${id}` : reel.video_url;

  return (
    <div className="min-w-0">
      <div className="relative aspect-[9/13] rounded-lg overflow-hidden bg-model-line ring-1 ring-model-ink/10">
        {playing && !failed ? (
          <video
            src={videoSrc}
            poster={thumbnailSrc}
            autoPlay
            playsInline
            muted
            controls
            className="absolute inset-0 w-full h-full object-cover"
            onError={() => setFailed(true)}
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
                onClick={() => setPlaying(true)}
                className="absolute inset-0 flex items-center justify-center"
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
        <div className="text-[10px] font-bold text-model-coral truncate">@{reel.account_handle}</div>
      )}
    </div>
  );
}
