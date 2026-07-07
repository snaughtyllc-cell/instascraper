import React from 'react';
import { daysAgoISO, DATE_PRESETS, presetForStartDate } from '../utils/date';

export default function FilterBar({ filters, accounts, contentTypes = [], total, onChange, onExport }) {
  const activePreset = presetForStartDate(filters.startDate);

  const [searchText, setSearchText] = React.useState(filters.search || '');
  React.useEffect(() => { setSearchText(filters.search || ''); }, [filters.search]);
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchText !== (filters.search || '')) onChange('search', searchText);
    }, 300);
    return () => clearTimeout(t);
  }, [searchText]); // eslint-disable-line

  const handlePreset = (value) => {
    const preset = DATE_PRESETS.find((p) => p.value === value);
    if (!preset) return;
    onChange('startDate', preset.days == null ? '' : daysAgoISO(preset.days));
  };

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* Caption Search */}
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search captions…"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 w-44"
        />

        {/* Sort */}
        <select
          value={filters.sort}
          onChange={(e) => onChange('sort', e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="most_viewed">Most Viewed</option>
          <option value="views_vs_median">Views vs Median</option>
          <option value="most_liked">Most Liked</option>
          <option value="highest_er">Highest ER%</option>
          <option value="lowest_er">Lowest ER%</option>
        </select>

        {/* Tag Filter */}
        <select
          value={filters.tag}
          onChange={(e) => onChange('tag', e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="">All Tags</option>
          <option value="recreate">Recreate</option>
          <option value="reference">Reference</option>
          <option value="skip">Skip</option>
          <option value="__untagged__">Untagged</option>
        </select>

        {/* Account Filter */}
        <select
          value={filters.account}
          onChange={(e) => onChange('account', e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="">All Accounts</option>
          {accounts.map((a) => (
            <option key={a} value={a}>@{a}</option>
          ))}
        </select>

        {/* Creator Content Type Filter */}
        <select
          value={filters.contentType || ''}
          onChange={(e) => onChange('contentType', e.target.value)}
          className={`bg-gray-800 border rounded-lg px-3 py-2 text-sm ${
            filters.contentType ? 'border-purple-600/50 text-purple-300' : 'border-gray-700 text-white'
          }`}
        >
          <option value="">All Types</option>
          {contentTypes.map((ct) => (
            <option key={ct.value} value={ct.value}>{ct.label}</option>
          ))}
        </select>

        {/* Min Views */}
        <input
          type="number"
          value={filters.minViews}
          onChange={(e) => onChange('minViews', e.target.value)}
          placeholder="Min views"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 w-28"
        />

        {/* Date Range preset */}
        <select
          value={activePreset}
          onChange={(e) => handlePreset(e.target.value)}
          title="Date range"
          className={`bg-gray-800 border rounded-lg px-3 py-2 text-sm ${
            activePreset === 'all' ? 'border-gray-700 text-white' : 'border-gold/50 text-gold'
          }`}
        >
          {DATE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
          {activePreset === 'custom' && <option value="custom">Custom</option>}
        </select>

        {/* Date Range */}
        <input
          type="date"
          value={filters.startDate}
          onChange={(e) => onChange('startDate', e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <span className="text-gray-500 text-sm">to</span>
        <input
          type="date"
          value={filters.endDate}
          onChange={(e) => onChange('endDate', e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
        />

        {/* Show Archived Toggle */}
        <button
          onClick={() => onChange('showArchived', !filters.showArchived)}
          className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all flex items-center gap-1.5 ${
            filters.showArchived
              ? 'bg-yellow-600/20 border-yellow-600/40 text-yellow-400'
              : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-300'
          }`}
        >
          📦 {filters.showArchived ? 'Showing Archived' : 'Show Archived'}
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Count + Export */}
        <span className="text-sm text-gray-400">{total} posts</span>
        <button
          onClick={onExport}
          className="bg-gold hover:bg-gold-light text-gray-950 font-semibold px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-1.5"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Export Recreate
        </button>
      </div>
    </div>
  );
}
