import React, { useCallback, useEffect, useState } from 'react';
import { getModelCockpit } from '../api';

const FEEDBACK_LABELS = {
  want_to_make: 'Wants to make',
  not_my_style: 'Pass',
  too_hard: 'Too hard',
  already_done: 'Already done',
  need_script: 'Needs script',
  done: 'Done',
};

function num(value) {
  return Number(value || 0).toLocaleString();
}

function shortDate(value) {
  if (!value) return 'No activity';
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function reactionRate(model) {
  if (!model.assigned_count) return 0;
  return Math.round((model.reacted_count / model.assigned_count) * 100);
}

export default function AdminCockpitTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getModelCockpit();
      setData(res.data);
    } catch (err) {
      console.error('Failed to load model cockpit:', err);
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const summary = data?.summary || {};
  const models = data?.models || [];
  const recent = data?.recent || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Model Cockpit</h2>
          <p className="mt-1 text-sm text-gray-400">Assignments, reactions, and ready-to-script signals.</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="self-start rounded-lg bg-gray-800 px-3 py-2 text-sm font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50 sm:self-auto"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {[
          ['Models', summary.models],
          ['Logins On', summary.loginEnabled],
          ['Assigned', summary.assigned],
          ['Reacted', summary.reacted],
          ['Want', summary.want],
          ['Need Script', summary.script],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
            <p className="mt-1 text-2xl font-bold text-white">{num(value)}</p>
          </div>
        ))}
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-20 text-gray-500">
          <svg className="mr-2 h-6 w-6 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Loading cockpit...
        </div>
      ) : models.length === 0 ? (
        <div className="rounded-lg border border-gray-800 bg-gray-900 px-5 py-10 text-center">
          <p className="text-sm text-gray-400">No active models yet.</p>
          <p className="mt-1 text-xs text-gray-600">Create model logins, assign reels, then reactions will show here.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
          <div className="hidden grid-cols-[minmax(180px,1.4fr)_repeat(5,minmax(82px,0.7fr))] gap-3 border-b border-gray-800 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500 md:grid">
            <span>Model</span>
            <span>Assigned</span>
            <span>Reacted</span>
            <span>Want</span>
            <span>Script</span>
            <span>Last Touch</span>
          </div>
          <div className="divide-y divide-gray-800">
            {models.map((model) => (
              <div key={model.id} className="grid grid-cols-1 gap-3 px-4 py-4 md:grid-cols-[minmax(180px,1.4fr)_repeat(5,minmax(82px,0.7fr))] md:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-white">{model.name}</h3>
                    <span className={`rounded px-2 py-0.5 text-xs ${model.login_enabled ? 'bg-emerald-900/40 text-emerald-300' : 'bg-gray-800 text-gray-500'}`}>
                      Login {model.login_enabled ? 'on' : 'off'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">{model.primary_niche || 'No niche'}</p>
                </div>
                <Metric label="Assigned" value={model.assigned_count} />
                <div>
                  <Metric label="Reacted" value={`${num(model.reacted_count)} (${reactionRate(model)}%)`} />
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-800">
                    <div className="h-full bg-gold" style={{ width: `${reactionRate(model)}%` }} />
                  </div>
                </div>
                <Metric label="Want" value={model.want_count} tone="text-gold" />
                <Metric label="Script" value={model.script_count} tone="text-blue-300" />
                <Metric label="Last Touch" value={shortDate(model.latest_feedback_at || model.latest_assigned_at)} />
              </div>
            ))}
          </div>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Recent Activity</h3>
          <span className="text-xs text-gray-500">{recent.length} rows</span>
        </div>
        <div className="space-y-2">
          {recent.length === 0 ? (
            <div className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-8 text-center text-sm text-gray-500">
              No assignment activity yet.
            </div>
          ) : recent.map((item) => (
            <div key={`${item.model_id}-${item.post_id}`} className="flex flex-col gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-white">{item.model_name}</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${item.feedback ? 'bg-gold/20 text-gold' : 'bg-gray-800 text-gray-500'}`}>
                    {FEEDBACK_LABELS[item.feedback] || 'Assigned'}
                  </span>
                  {item.content_type && <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">{item.content_type}</span>}
                </div>
                <p className="mt-1 truncate text-xs text-gray-500">
                  @{item.account_handle || 'unknown'} {item.caption ? `- ${item.caption}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-gray-600">{shortDate(item.feedback_at || item.assigned_at)}</span>
                {item.post_url && (
                  <a href={item.post_url} target="_blank" rel="noopener noreferrer" className="rounded bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 hover:bg-gray-700">
                    Open
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, tone = 'text-white' }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-600 md:hidden">{label}</p>
      <p className={`text-sm font-semibold ${tone}`}>{typeof value === 'number' ? num(value) : value}</p>
    </div>
  );
}
