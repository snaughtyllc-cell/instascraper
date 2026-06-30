import React from 'react';

const TYPES = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc'];

export default function BulkActionBar({ count, onTag, onArchive, onSetType, onSelectAll, onClear }) {
  if (count === 0) return null;
  return (
    <div className="sticky top-2 z-20 bg-gray-900 border border-gold/40 rounded-xl p-3 flex flex-wrap items-center gap-2 shadow-lg">
      <span className="text-sm font-semibold text-gold mr-1">{count} selected</span>

      <span className="text-xs text-gray-500">Tag:</span>
      <button onClick={() => onTag('recreate')} className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white">♻️ Recreate</button>
      <button onClick={() => onTag('reference')} className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white">🔖 Reference</button>
      <button onClick={() => onTag('skip')} className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white">⏭️ Skip</button>

      <button onClick={() => onArchive(true)} className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white">📦 Archive</button>
      <button onClick={() => onArchive(false)} className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white">📤 Unarchive</button>

      <select
        defaultValue=""
        onChange={(e) => { if (e.target.value) { onSetType(e.target.value); e.target.value = ''; } }}
        className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300"
      >
        <option value="">Set type…</option>
        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>

      <div className="flex-1" />
      <button onClick={onSelectAll} className="px-2.5 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white">Select all on page</button>
      <button onClick={onClear} className="px-2.5 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white">Clear</button>
    </div>
  );
}
