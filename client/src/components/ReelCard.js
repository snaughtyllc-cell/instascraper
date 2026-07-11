import React, { useState, useEffect, useRef } from 'react';

// Lean, model-only reel card (Feed + Saved). The reel fills the screen and every
// piece of context — @handle, ER, views, caption, and the Save / Open / Sound
// actions — rides ON the video, Instagram-style. The admin Library keeps
// ContentCard untouched.
//
// PLAYBACK (the "videos won't play on the phone" fix): React's `muted` prop is
// unreliable on iOS — it sets the attribute but not the muted *property*, so iOS
// treats a muted-autoplay <video> as unmuted and silently BLOCKS autoplay,
// leaving a frozen poster. We therefore set `muted` on the element imperatively
// and call play() ourselves, and make the whole reel tap-to-play/pause so a
// blocked autoplay (e.g. iOS Low Power Mode) is always recoverable by tapping.

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
  onFeedback,
  feedback,
}) {
  const [showVideo, setShowVideo] = useState(false); // desktop tap-to-play fallback
  const [videoFailed, setVideoFailed] = useState(false);
  const [manualPaused, setManualPaused] = useState(false);
  const cardRef = useRef(null);
  const videoRef = useRef(null);

  const cardId = post.id ?? post.shortcode;
  const reelUrl = post.post_url || (post.shortcode ? `https://www.instagram.com/reel/${post.shortcode}/` : null);
  const thumbnailSrc = cardId ? `${API_URL}/thumb/${cardId}` : post.thumbnail_url;
  const videoSrc = cardId ? `${API_URL}/video/${cardId}` : post.video_url;
  const typeLabel = post.niche || post.content_type;

  // Reset per-reel playback flags when the underlying reel changes.
  useEffect(() => { setVideoFailed(false); setManualPaused(false); }, [cardId]);

  // Register with the shared in-view observer so only the most-visible reel plays.
  useEffect(() => {
    if (!autoplayInView || !registerRef || !cardRef.current) return;
    const el = cardRef.current;
    registerRef(cardId, el);
    return () => registerRef(cardId, null);
  }, [autoplayInView, registerRef, cardId]);

  const playing = (showVideo || (autoplayInView && isActive)) && !videoFailed && cardId != null;

  // Drive playback imperatively (see file header). Runs whenever the reel becomes
  // the active/playing one, or when mute/pause state changes.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !playing) return;
    el.muted = autoplayInView ? !soundOn : false;
    if (!manualPaused) {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }, [playing, autoplayInView, soundOn, manualPaused]);

  // Tap the reel surface. If the <video> isn't mounted yet (this reel is showing
  // its poster because it isn't the active/autoplaying one, or a prior load
  // errored), force-mount it and let the playback effect start it. Otherwise
  // toggle play/pause. This is what makes tapping ANY reel play it — not just the
  // one the in-view observer picked.
  const handleSurfaceTap = () => {
    const el = videoRef.current;
    if (!el) {
      setVideoFailed(false); // retry a prior error
      setShowVideo(true);    // mount now; the effect calls play()
      return;
    }
    if (el.paused) {
      el.muted = autoplayInView ? !soundOn : false;
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      setManualPaused(false);
    } else {
      el.pause();
      setManualPaused(true);
    }
  };

  // Center play affordance: whenever a reel is showing its poster (tap to play),
  // or when it's paused.
  const showCenterPlay = !playing || manualPaused;

  return (
    <div
      ref={cardRef}
      className="relative w-full h-[80svh] min-h-[440px] rounded-2xl overflow-hidden bg-black"
    >
      {/* Media — true aspect, no crop */}
      {playing ? (
        <video
          ref={videoRef}
          src={videoSrc}
          poster={thumbnailSrc}
          autoPlay
          playsInline
          muted={autoplayInView ? !soundOn : false}
          loop={autoplayInView}
          controls={false}
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

      {/* Full-surface tap layer: play/pause (mobile) or start (desktop). Sits below
          the action rail (z-20) and above the pointer-events-none overlay. */}
      <button
        type="button"
        onClick={handleSurfaceTap}
        className="absolute inset-0 z-[5] w-full h-full"
        aria-label={playing && !manualPaused ? 'Pause' : 'Play'}
      >
        {showCenterPlay && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="w-16 h-16 rounded-full bg-black/45 flex items-center justify-center backdrop-blur">
              <svg className="w-7 h-7 text-white ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            </span>
          </span>
        )}
      </button>

      {/* "playing" pill — reassures the model the video is live */}
      {playing && !manualPaused && autoplayInView && (
        <div className="pointer-events-none absolute top-3 left-3 z-20 flex items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur">
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

      {onFeedback && (
        <div className="absolute left-3 right-16 bottom-[168px] z-20 flex flex-wrap gap-1.5">
          {[
            ['want_to_make', 'Want'],
            ['not_my_style', 'Pass'],
            ['too_hard', 'Hard'],
            ['need_script', 'Script'],
            ['done', 'Done'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={(e) => { e.stopPropagation(); onFeedback(post, value); }}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold backdrop-blur border ${
                feedback === value
                  ? 'bg-gold text-gray-950 border-gold'
                  : 'bg-black/45 text-white border-white/20 hover:border-white/50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Bottom overlay: handle + meta + caption + type — pointer-events-none so
          taps fall through to the play/pause surface. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3.5 pt-9 pb-3.5 pr-16 bg-gradient-to-t from-black/85 via-black/35 to-transparent">
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
