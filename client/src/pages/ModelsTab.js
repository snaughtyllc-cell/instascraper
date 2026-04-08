import React, { useState, useEffect, useCallback } from 'react';
import { getModels, createModel, updateModel, deleteModel, getAvailableNiches, generateIdeas, getIdeas, exportIdeas, exportIdeasToNotion } from '../api';

const DELIVERY_METHODS = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sheet', label: 'Google Sheet' },
  { value: 'notion', label: 'Notion' },
];

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const NICHE_OPTIONS = ['talking', 'dance', 'skit', 'snapchat', 'omegle', 'osc'];

export default function ModelsTab() {
  const [models, setModels] = useState([]);
  const [niches, setNiches] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [expandedModel, setExpandedModel] = useState(null);
  const [ideas, setIdeas] = useState({});
  const [generating, setGenerating] = useState({});
  const [exportOpen, setExportOpen] = useState(null);
  const [form, setForm] = useState({
    name: '', primary_niche: '', secondary_niches: '',
    delivery_method: 'whatsapp', delivery_contact: '', delivery_day: 'monday',
  });

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
      setForm({ name: '', primary_niche: '', secondary_niches: '', delivery_method: 'whatsapp', delivery_contact: '', delivery_day: 'monday' });
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
        <button
          onClick={() => { setShowForm(!showForm); setEditingId(null); setForm({ name: '', primary_niche: '', secondary_niches: '', delivery_method: 'whatsapp', delivery_contact: '', delivery_day: 'monday' }); }}
          className="px-4 py-2 bg-gold text-gray-950 rounded-lg font-medium hover:bg-gold/90 transition-colors"
        >
          + Add Model
        </button>
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
    </div>
  );
}
