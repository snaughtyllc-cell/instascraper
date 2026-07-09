import React, { useState, useEffect, useCallback } from 'react';
import { getModels, createModel, updateModel, deleteModel, getAvailableNiches, generateIdeas, getIdeas, exportIdeas, exportIdeasToNotion, getNotionPersonas, previewNotionPersona, importNotionPersona, resyncNotion } from '../api';

const DELIVERY_METHODS = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sheet', label: 'Google Sheet' },
  { value: 'notion', label: 'Notion' },
];

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const NICHE_OPTIONS = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc'];

const EMPTY_FORM = {
  name: '', primary_niche: '', secondary_niches: '',
  delivery_method: 'whatsapp', delivery_contact: '', delivery_day: 'monday',
  email: '', password: '', login_enabled: false,
};

export default function ModelsTab() {
  const [models, setModels] = useState([]);
  const [niches, setNiches] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [expandedModel, setExpandedModel] = useState(null);
  const [ideas, setIdeas] = useState({});
  const [generating, setGenerating] = useState({});
  const [exportOpen, setExportOpen] = useState(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [notion, setNotion] = useState({ open: false, enabled: null, personas: [], loading: false });
  const [importForm, setImportForm] = useState(null); // { pageId, name, preview, primary_niche, secondary_niches, email, password }

  const loadModels = useCallback(async () => {
    try {
      const { data } = await getModels();
      setModels(data);
    } catch (err) { console.error('Failed to load models:', err); }
  }, []);

  const loadNiches = useCallback(async () => {
    try {
      const { data } = await getAvailableNiches();
      setNiches([...new Set([...NICHE_OPTIONS, ...data])]);
    } catch { setNiches(NICHE_OPTIONS); }
  }, []);

  useEffect(() => { loadModels(); loadNiches(); }, [loadModels, loadNiches]);

  const openNotion = async () => {
    setNotion((n) => ({ ...n, open: true, loading: true }));
    try {
      const { data } = await getNotionPersonas();
      setNotion({ open: true, enabled: data.enabled, personas: data.personas || [], loading: false });
    } catch (err) { setNotion({ open: true, enabled: false, personas: [], loading: false }); }
  };

  const startImport = async (p) => {
    try {
      const { data } = await previewNotionPersona(p.pageId);
      setImportForm({
        pageId: p.pageId, name: data.name, preview: data,
        primary_niche: data.proposedPrimary || '', secondary_niches: (data.proposedSecondary || []).join(','),
        email: '', password: '',
      });
    } catch (err) { alert('Preview failed: ' + (err.response?.data?.error || err.message)); }
  };

  const submitImport = async () => {
    try {
      await importNotionPersona(importForm.pageId, {
        primary_niche: importForm.primary_niche,
        secondary_niches: importForm.secondary_niches,
        character_context: importForm.preview.characterContext,
        email: importForm.email, password: importForm.password,
        seedKeywords: importForm.preview.seedKeywords,
      });
      setImportForm(null);
      setNotion((n) => ({ ...n, open: false }));
      loadModels();
    } catch (err) { alert('Import failed: ' + (err.response?.data?.error || err.message)); }
  };

  const doResync = async (model) => {
    try {
      const { data } = await resyncNotion(model.id, false);
      const d = data.diff;
      const msg = `Re-sync "${model.name}" from Notion?\n\nniche: ${d.current.primary_niche} → ${d.proposed.primary_niche}\nstatus: ${d.current.status} → ${d.proposed.status}`;
      if (window.confirm(msg)) { await resyncNotion(model.id, true); loadModels(); }
    } catch (err) { alert('Re-sync failed: ' + (err.response?.data?.error || err.message)); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingId) {
        await updateModel(editingId, form);
      } else {
        await createModel(form);
      }
      setShowForm(false);
      setEditingId(null);
      setForm({ ...EMPTY_FORM });
      loadModels();
    } catch (err) { alert('Error: ' + (err.response?.data?.error || err.message)); }
  };

  const handleEdit = (model) => {
    setForm({
      name: model.name, primary_niche: model.primary_niche,
      secondary_niches: model.secondary_niches || '',
      delivery_method: model.delivery_method || 'whatsapp',
      delivery_contact: model.delivery_contact || '',
      delivery_day: model.delivery_day || 'monday',
      email: model.email || '', password: '', login_enabled: !!model.login_enabled,
    });
    setEditingId(model.id);
    setShowForm(true);
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Remove ${name}?`)) return;
    await deleteModel(id);
    loadModels();
  };

  const handleGenerate = async (modelId) => {
    setGenerating(g => ({ ...g, [modelId]: true }));
    try {
      const { data } = await generateIdeas(modelId);
      alert(`Generated ${data.ideaCount} ideas (batch: ${data.batchId})`);
      loadIdeas(modelId);
    } catch (err) {
      alert('Generation failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setGenerating(g => ({ ...g, [modelId]: false }));
    }
  };

  const loadIdeas = async (modelId) => {
    try {
      const { data } = await getIdeas(modelId);
      setIdeas(prev => ({ ...prev, [modelId]: data }));
    } catch (err) { console.error('Failed to load ideas:', err); }
  };

  const toggleExpand = (modelId) => {
    if (expandedModel === modelId) {
      setExpandedModel(null);
    } else {
      setExpandedModel(modelId);
      if (!ideas[modelId]) loadIdeas(modelId);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">My Models</h2>
          <p className="text-gray-400 text-sm mt-1">AI-powered content idea generation per model</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={openNotion} className="px-3 py-2 rounded bg-gold text-gray-950 font-medium">Import from Notion</button>
          <button
            onClick={() => { setShowForm(!showForm); setEditingId(null); setForm({ ...EMPTY_FORM }); }}
            className="px-4 py-2 bg-gold text-gray-950 rounded-lg font-medium hover:bg-gold/90 transition-colors"
          >
            + Add Model
          </button>
        </div>
      </div>

      {/* Add/Edit Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
          <h3 className="text-lg font-semibold text-white">{editingId ? 'Edit Model' : 'New Model'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name *</label>
              <input
                type="text" required value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-gold focus:outline-none"
                placeholder="e.g. Sabrina"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Primary Niche *</label>
              <select
                required value={form.primary_niche}
                onChange={e => setForm({ ...form, primary_niche: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-gold focus:outline-none"
              >
                <option value="">Select niche...</option>
                {niches.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Secondary Niches</label>
              <input
                type="text" value={form.secondary_niches}
                onChange={e => setForm({ ...form, secondary_niches: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-gold focus:outline-none"
                placeholder="comma-separated, e.g. dance, skit"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Delivery Day</label>
              <select
                value={form.delivery_day}
                onChange={e => setForm({ ...form, delivery_day: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-gold focus:outline-none"
              >
                {DAYS.map(d => <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Delivery Method</label>
              <select
                value={form.delivery_method}
                onChange={e => setForm({ ...form, delivery_method: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-gold focus:outline-none"
              >
                {DELIVERY_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Delivery Contact</label>
              <input
                type="text" value={form.delivery_contact}
                onChange={e => setForm({ ...form, delivery_contact: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-gold focus:outline-none"
                placeholder={form.delivery_method === 'whatsapp' ? '+1234567890' : form.delivery_method === 'sheet' ? 'Google Sheet URL' : 'Notion page ID'}
              />
            </div>
          </div>

          <div className="border-t border-gray-800 pt-4">
            <h4 className="text-sm font-semibold text-gray-300 mb-3">Model App Login</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Email</label>
                <input
                  type="email" value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-gold focus:outline-none"
                  placeholder="Email (for model login)"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Password</label>
                <input
                  type="password" value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-gold focus:outline-none"
                  placeholder="Set / reset password — blank keeps current"
                  autoComplete="new-password"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 mt-3 text-sm text-gray-400">
              <input
                type="checkbox" checked={form.login_enabled}
                onChange={e => setForm({ ...form, login_enabled: e.target.checked })}
                className="w-4 h-4 rounded bg-gray-800 border-gray-700 text-gold focus:ring-gold focus:ring-offset-gray-900"
              />
              Enable login
            </label>
          </div>

          <div className="flex gap-3">
            <button type="submit" className="px-4 py-2 bg-gold text-gray-950 rounded-lg font-medium hover:bg-gold/90">
              {editingId ? 'Save Changes' : 'Create Model'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }} className="px-4 py-2 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Model Cards */}
      {models.length === 0 && !showForm && (
        <div className="text-center py-12 text-gray-500">
          No models yet. Click "+ Add Model" to create your first content idea profile.
        </div>
      )}

      <div className="space-y-4">
        {models.map(model => (
          <div key={model.id} className="bg-gray-900 border border-gray-800 rounded-xl">
            {/* Model Header */}
            <div className="p-5 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-gold/20 flex items-center justify-center text-gold font-bold text-lg">
                  {model.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-white font-semibold text-lg">{model.name}</h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gold/20 text-gold">{model.primary_niche}</span>
                    {model.secondary_niches && model.secondary_niches.split(',').filter(Boolean).map(n => (
                      <span key={n.trim()} className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">{n.trim()}</span>
                    ))}
                    <span className={`text-xs px-2 py-0.5 rounded-full ${model.login_enabled ? 'bg-emerald-900/40 text-emerald-300' : 'bg-gray-800 text-gray-500'}`}>
                      Login: {model.login_enabled ? 'on' : 'off'}
                    </span>
                    {model.email && (
                      <span className="text-xs text-gray-500">{model.email}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 mr-2">
                  {model.delivery_method} &middot; {model.delivery_day}
                </span>
                <button
                  onClick={() => handleGenerate(model.id)}
                  disabled={generating[model.id]}
                  className="px-3 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {generating[model.id] ? 'Generating...' : 'Generate Now'}
                </button>
                <button
                  onClick={() => toggleExpand(model.id)}
                  className="px-3 py-1.5 bg-gray-800 text-gray-300 text-sm rounded-lg hover:bg-gray-700"
                >
                  {expandedModel === model.id ? 'Hide Ideas' : 'View Ideas'}
                </button>
                <div className="relative">
                  <button
                    onClick={() => setExportOpen(exportOpen === model.id ? null : model.id)}
                    className="px-3 py-1.5 bg-gray-800 text-gray-300 text-sm rounded-lg hover:bg-gray-700"
                  >
                    Export &#9662;
                  </button>
                  {exportOpen === model.id && (
                    <div className="absolute right-0 top-full mt-1 w-44 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
                      <button onClick={() => { exportIdeas(model.id, 'pdf'); setExportOpen(null); }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700">PDF</button>
                      <button onClick={() => { exportIdeas(model.id, 'csv'); setExportOpen(null); }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700">CSV</button>
                      <button onClick={() => { exportIdeas(model.id, 'json'); setExportOpen(null); }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700">JSON</button>
                      <button onClick={async () => {
                        setExportOpen(null);
                        const pageId = window.prompt('Enter your Notion page ID:');
                        if (!pageId) return;
                        try {
                          await exportIdeasToNotion(model.id, pageId);
                          alert('Ideas sent to Notion!');
                        } catch (err) {
                          alert('Notion export failed: ' + (err.response?.data?.error || err.message));
                        }
                      }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 border-t border-gray-700">Send to Notion</button>
                    </div>
                  )}
                </div>
                {model.notion_page_id && <button onClick={() => doResync(model)} className="px-2 py-1 text-sm rounded bg-gray-700">Re-sync</button>}
                <button onClick={() => handleEdit(model)} className="p-1.5 text-gray-500 hover:text-white">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                </button>
                <button onClick={() => handleDelete(model.id, model.name)} className="p-1.5 text-gray-500 hover:text-red-400">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              </div>
            </div>

            {/* Expanded Ideas */}
            {expandedModel === model.id && (
              <div className="border-t border-gray-800 p-5">
                {!ideas[model.id] ? (
                  <div className="text-gray-500 text-sm">Loading ideas...</div>
                ) : ideas[model.id].length === 0 ? (
                  <div className="text-gray-500 text-sm">No ideas generated yet. Click "Generate Now" to create content ideas.</div>
                ) : (
                  <div className="space-y-3">
                    <h4 className="text-sm font-medium text-gray-400">Recent Ideas</h4>
                    {ideas[model.id].map(idea => (
                      <div key={idea.id} className={`p-4 rounded-lg border ${idea.stale_warning ? 'bg-yellow-900/10 border-yellow-800/30' : 'bg-gray-800/50 border-gray-700/50'}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1">
                            <p className="text-white text-sm">{idea.concept}</p>
                            <div className="flex flex-wrap items-center gap-2 mt-2">
                              {idea.format && <span className="text-xs px-2 py-0.5 rounded bg-blue-900/40 text-blue-300">{idea.format}</span>}
                              {idea.source_niche && <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-400">{idea.source_niche}</span>}
                              <span className={`text-xs px-2 py-0.5 rounded ${idea.status === 'delivered' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-gray-700 text-gray-400'}`}>
                                {idea.status}
                              </span>
                            </div>
                            {idea.hook_line && (
                              <p className="text-xs text-gold/80 mt-2 italic">Hook: "{idea.hook_line}"</p>
                            )}
                            {idea.why_working && (
                              <p className="text-xs text-gray-500 mt-1">{idea.why_working}</p>
                            )}
                            {idea.source_post_ids && idea.source_post_ids.trim() && (
                              <div className="flex flex-wrap gap-2 mt-2">
                                {idea.source_post_ids.split(',').filter(Boolean).map((url, i) => (
                                  <a key={i} href={url.trim().startsWith('http') ? url.trim() : `https://www.instagram.com/reel/${url.trim()}/`}
                                    target="_blank" rel="noopener noreferrer"
                                    className="text-xs px-2 py-0.5 rounded bg-purple-900/40 text-purple-300 hover:bg-purple-800/50 transition-colors">
                                    Reference {i + 1}
                                  </a>
                                ))}
                              </div>
                            )}
                            {idea.stale_warning && (
                              <p className="text-xs text-yellow-500 mt-1">Warning: {idea.stale_warning}</p>
                            )}
                          </div>
                          <span className="text-xs text-gray-600 whitespace-nowrap">
                            {idea.created_at ? new Date(idea.created_at).toLocaleDateString() : ''}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {notion.open && !importForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setNotion((n) => ({ ...n, open: false }))}>
          <div className="bg-gray-900 p-5 rounded-lg w-[min(560px,92vw)] max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-3">Import model from Notion</h3>
            {notion.loading && <p className="text-gray-400">Loading personas…</p>}
            {notion.enabled === false && <p className="text-gray-400">Notion isn't configured (set NOTION_API_KEY + NOTION_PERSONAS_DB_ID).</p>}
            {notion.enabled && notion.personas.length === 0 && <p className="text-gray-400">No Approved personas found.</p>}
            {notion.personas.map((p) => (
              <div key={p.pageId} className="flex items-center justify-between py-2 border-b border-gray-800">
                <span>{p.name} <span className="text-xs text-gray-500">({p.status})</span></span>
                {p.linked
                  ? <span className="text-xs text-gray-500">already imported</span>
                  : <button onClick={() => startImport(p)} className="px-2 py-1 text-sm rounded bg-gold text-gray-950">Import</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      {importForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 p-5 rounded-lg w-[min(560px,92vw)] max-h-[85vh] overflow-y-auto">
            <h3 className="text-lg font-semibold mb-1">Import {importForm.name}</h3>
            <p className="text-xs text-gray-400 mb-3">{importForm.preview.personaStatement}</p>
            <label className="block text-sm mb-1">Primary niche</label>
            <select value={importForm.primary_niche} onChange={(e) => setImportForm({ ...importForm, primary_niche: e.target.value })} className="w-full mb-3 bg-gray-800 rounded p-2">
              <option value="">— pick —</option>
              {niches.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <label className="block text-sm mb-1">Secondary niches (comma-separated)</label>
            <input value={importForm.secondary_niches} onChange={(e) => setImportForm({ ...importForm, secondary_niches: e.target.value })} className="w-full mb-3 bg-gray-800 rounded p-2" />
            {importForm.preview.unmatchedNiches?.length > 0 && <p className="text-xs text-yellow-500 mb-3">No InstaScraper niche for: {importForm.preview.unmatchedNiches.join(', ')}</p>}
            <label className="block text-sm mb-1">Login email</label>
            <input value={importForm.email} onChange={(e) => setImportForm({ ...importForm, email: e.target.value })} className="w-full mb-3 bg-gray-800 rounded p-2" />
            <label className="block text-sm mb-1">Password</label>
            <input type="password" value={importForm.password} onChange={(e) => setImportForm({ ...importForm, password: e.target.value })} className="w-full mb-4 bg-gray-800 rounded p-2" />
            <details className="mb-4"><summary className="text-sm text-gray-400 cursor-pointer">Character context (AI)</summary><pre className="text-xs whitespace-pre-wrap text-gray-300 mt-2">{importForm.preview.characterContext}</pre></details>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setImportForm(null)} className="px-3 py-2 rounded bg-gray-700">Cancel</button>
              <button onClick={submitImport} disabled={!importForm.primary_niche || !importForm.email || !importForm.password} className="px-3 py-2 rounded bg-gold text-gray-950 disabled:opacity-50">Create model</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
