import { useState, useEffect, useCallback, useRef } from 'react';

// Reusable "which card is most visible" coordinator, extracted from the
// admin LibraryTab's autoplay-in-view logic. On touch devices (coarse
// pointer) it runs a single IntersectionObserver across all registered
// cards and tracks which one is most in-view, so only that card autoplays
// its video. On non-touch devices autoplayInView stays false and callers
// should fall back to hover/click-to-play behavior.
//
// Usage:
//   const { autoplayInView, activeCardId, registerRef } = useActiveInView(posts);
//   <ContentCard
//     autoplayInView={autoplayInView}
//     isActive={String(post.id ?? post.shortcode) === activeCardId}
//     registerRef={registerRef}
//     ...
//   />
export default function useActiveInView(items) {
  const autoplayInView = typeof window !== 'undefined'
    && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const [activeCardId, setActiveCardId] = useState(null);
  const nodeMap = useRef(new Map());       // id -> DOM node
  const ratioMap = useRef(new Map());      // id -> intersectionRatio
  const observerRef = useRef(null);

  const registerRef = useCallback((id, node) => {
    if (!autoplayInView) return;
    const key = String(id);
    if (!node) {
      const prev = nodeMap.current.get(key);
      if (prev && observerRef.current) observerRef.current.unobserve(prev);
      nodeMap.current.delete(key);
      ratioMap.current.delete(key);
      return;
    }
    nodeMap.current.set(key, node);
    node.dataset.cardId = key;
    if (observerRef.current) observerRef.current.observe(node);
  }, [autoplayInView]);

  useEffect(() => {
    if (!autoplayInView) return;
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = e.target.dataset.cardId;
        ratioMap.current.set(id, e.isIntersecting ? e.intersectionRatio : 0);
      }
      let bestId = null, best = 0;
      for (const [id, r] of ratioMap.current.entries()) {
        if (r > best) { best = r; bestId = id; }
      }
      setActiveCardId(best >= 0.6 ? bestId : null);
    }, { threshold: [0, 0.6, 1] });
    observerRef.current = obs;
    for (const node of nodeMap.current.values()) obs.observe(node);
    return () => obs.disconnect();
  }, [autoplayInView, items]);

  return { autoplayInView, activeCardId, registerRef };
}
