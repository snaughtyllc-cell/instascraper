import React, { useState, useEffect, useRef } from 'react';

// Lean, model-only reel card (Feed + Saved). Deliberately NOT the shared admin
// ContentCard: the reel fills the screen and every piece of context — @handle,
// ER, views, caption, and the Save / Open / Sound actions — rides ON the video,
// Instagram-style, so the reel stays big and the model never scrolls to see
// context. The admin Library keeps ContentCard untouched.

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:4000';

function formatCount(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}
function formatViews(n) {
  if (n === null || n === undefined) return '—';
  return formatCount(n);
}
function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function ReelCard({
  post,
  autoplayInView = false,
  isActive = false,
  soundOn = false,
  onToggleSound,
  registerRef,
  onToggleSave,
  isSaved = false,
}) {
  const [showVideo, setShowVideo] = useState(false); // desktop tap-to-play fallback
  const [videoFailed, setVideoFailed] = useState(false);
  const cardRef = useRef(null);

  const cardId = post.id ?? post.shortcode;
  const reelUrl = post.post_url || (post.shortcode ? `https://www.instagram.com/reel/${post.shortcode}/` : null);
  const thumbnailSrc = cardId ? `${API_URL}/thumb/${cardId}` : post.thumbnail_url;
  const videoSrc = cardId ? `${API_URL}/video/${cardId}` : post.video_url;
  const typeLabel = post.niche || post.content_type;

  // Reset the fallback-to-poster flag when the underlying reel changes.
  useEffect(() => { setVideoFailed(false); }, [cardId]);

  // Register with the shared in-view observer so only the most-visible reel plays.
  useEffect(() => {
    if (!autoplayInView || !registerRef || !cardRef.current) return;
    const el = cardRef.current;
    registerRef(cardId, el);
    return () => registerRef(cardId, null);
  }, [autoplayInView, registerRef, cardId]);

  const playing = (showVideo || (autoplayInView && isActive)) && !videoFailed && cardId != null;

  return (
    <div
      ref={cardRef}
      className="relative w-full h-[80svh] min-h-[440px] rounded-2xl overflow-hidden bg-black"
    >
      {/* Media — true aspect, no crop */}
      {playing ? (
        <video
          src={videoSrc}
          poster={thumbnailSrc}
          autoPlay
          playsInline
          muted={autoplayInView ? !soundOn : false}
          loop={autoplayInView}
          controls={!autoplayInView}
          className="absolute inset-0 w-full h-full object-contain"
          onError={() => setVideoFailed(true)}
        />
      ) : (
        <img
          src={thumbnailSrc}
          alt=""
          className="absolute inset-0 w-full h-full object-contain"
          loading="lazy"
          onError={(e) => {
            if (e.target.src !== post.thumbnail_url && post.thumbnail_url) e.target.src = post.thumbnail_url;
          }}
        />
      )}

      {/* Desktop / non-autoplay: center tap-to-play */}
      {!autoplayInView && !showVideo && (
        <button
          onClick={() => setShowVideo(true)}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/20 hover:bg-black/30 transition-colors"
          aria-label="Play reel"
        >
          <span className="w-16 h-16 rounded-full bg-white/90 flex items-center justify-center">
            <svg className="w-7 h-7 text-gray-900 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          </span>
        </button>
      )}

      {/* "playing" pill — reassures the model the video is live */}
      {playing && autoplayInView && (
        <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur">
          <span className="w-[7px] h-[7px] rounded-full bg-emerald-400" />
          playing
        </div>
      )}

      {/* Right action rail */}
      <div className="absolute right-2.5 bottom-24 z-20 flex flex-col items-center gap-5">
        {onToggleSave && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleSave(post); }}
            className="flex flex-col items-center gap-1 text-white"
            title={isSaved ? 'Unsave' : 'Save'}
          >
            <svg
              className={`w-7 h-7 drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)] ${isSaved ? 'text-gold' : 'text-white'}`}
              fill={isSaved ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
            <small className="text-[10.5px] font-semibold drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]">
              {isSaved ? 'Saved' : 'Save'}
            </small>
          </button>
        )}
        {reelUrl && (
          <a
            href={reelUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex flex-col items-center gap-1 text-white"
            title="Open on Instagram"
          >
            <svg className="w-7 h-7 drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="5" />
              <circle cx="12" cy="12" r="3.6" />
              <circle cx="17.4" cy="6.6" r="1" fill="currentColor" stroke="none" />
            </svg>
            <small className="text-[10.5px] font-semibold drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]">Open</small>
          </a>
        )}
        {autoplayInView && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleSound && onToggleSound(); }}
            className="flex flex-col items-center gap-1 text-white"
            title={soundOn ? 'Mute' : 'Unmute'}
          >
            <svg className="w-7 h-7 drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5L6 9H2v6h4l5 4V5z" />
              {soundOn
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 8.5a5 5 0 010 7M18 6a9 9 0 010 12" />
                : <path strokeLinecap="round" strokeLinejoin="round" d="M17 9l4 6m0-6l-4 6" />}
            </svg>
            <small className="text-[10.5px] font-semibold drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]">Sound</small>
          </button>
        )}
      </div>

      {/* Bottom overlay: handle + meta + caption + type — all ON the video */}
      <div className="absolute inset-x-0 bottom-0 z-10 px-3.5 pt-9 pb-3.5 pr-16 bg-gradient-to-t from-black/85 via-black/35 to-transparent">
        <div className="flex items-center gap-2 text-sm font-bold text-white">
          <span className="w-6 h-6 rounded-full bg-gradient-to-br from-gold to-[#b06a3d] ring-[1.5px] ring-white/70 shrink-0" />
          @{post.account_handle}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-semibold text-white/90">
          {post.er_percent != null && post.er_label && (
            <>
              <span className="text-emerald-400">{post.er_percent}% ER</span>
              <span className="w-[3px] h-[3px] rounded-full bg-white/40" />
            </>
          )}
          <span>{formatViews(post.view_count)} views</span>
          {post.posted_at && (
            <>
              <span className="w-[3px] h-[3px] rounded-full bg-white/40" />
              <span>{formatDate(post.posted_at)}</span>
            </>
          )}
        </div>
        {post.caption && (
          <p className="mt-1.5 text-[12.5px] leading-snug text-white/90 line-clamp-2">{post.caption}</p>
        )}
        {typeLabel && (
          <span className="mt-2 inline-block rounded-full border border-gold/35 bg-gold/15 px-2 py-0.5 text-[10.5px] font-semibold text-gold">
            {typeLabel}
          </span>
        )}
      </div>
    </div>
  );
}
