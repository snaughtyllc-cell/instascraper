import React from 'react';

export function tagValues(tags) {
  try {
    const values = Array.isArray(tags) ? tags : JSON.parse(tags);
    return Array.isArray(values) ? values.filter(value => typeof value === 'string' || (value && typeof value.tag === 'string')) : [];
  }
  catch { return []; }
}

export function LookTagChips({ tags, vocabulary = [], onRemove, disabled = false }) {
  const values = tagValues(tags);
  if (!values.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Look tags">
    {values.map(item => {
      const tag = typeof item === 'string' ? item : item.tag;
      const label = vocabulary.find(value => value.value === tag)?.label || tag;
      return <span key={tag} className="inline-flex items-center gap-1 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-300">
        {label}{typeof item.share === 'number' ? ` ${Math.round(item.share * 100)}%` : ''}
        {onRemove && item.manual && <button type="button" disabled={disabled} onClick={() => onRemove(tag)} aria-label={`Remove manual ${label} tag`} className="px-1 text-gray-400 hover:text-white disabled:opacity-50">×</button>}
      </span>;
    })}
  </div>;
}

export function LookTagPicker({ vocabulary, selected = [], onChange }) {
  return <fieldset className="space-y-3">
    <legend className="mb-2 text-sm font-semibold text-gray-300">Look tags</legend>
    <p className="text-xs text-gray-500">Matching looks rise in her feed. Every eligible reel stays available.</p>
    {['hair', 'aesthetic', 'setting', 'custom'].map(category => {
      const tags = vocabulary.filter(tag => tag.category === category);
      if (!tags.length) return null;
      return <div key={category}>
        <p className="mb-1.5 text-xs capitalize text-gray-400">{category}</p>
        <div className="flex flex-wrap gap-2">
          {tags.map(tag => <button key={tag.value} type="button" aria-pressed={selected.includes(tag.value)} onClick={() => onChange(selected.includes(tag.value) ? selected.filter(value => value !== tag.value) : [...selected, tag.value])}
            className={`rounded-lg border px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold ${selected.includes(tag.value) ? 'border-gold/60 bg-gold/10 text-gold' : 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-500'}`}>{tag.label}</button>)}
        </div>
      </div>;
    })}
  </fieldset>;
}
