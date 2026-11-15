import React from 'react';

export default function LayoutBadge({ layout }) {
  let label;
  switch (layout) {
    case 'split_screen': label = 'Split screen'; break;
    case 'gameplay_overlay': label = 'Gameplay'; break;
    case 'needs_footage': label = 'Needs footage'; break;
    default: return null;
  }
  return <span className="inline-flex rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">{label}</span>;
}
