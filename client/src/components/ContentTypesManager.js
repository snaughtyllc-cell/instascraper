import React, { useCallback, useEffect, useState } from 'react';
import { addContentType, getContentTypes, updateContentType } from '../api';

const inputClass = 'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white';
const buttonClass = 'rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-gold-light disabled:opacity-50';

export default function ContentTypesManager() {
  const [types, setTypes] = useState([]);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const { data } = await getContentTypes();
    setTypes(data);
  }, []);
  useEffect(() => { load().catch(err => setError(err.response?.data?.error || err.message)); }, [load]);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (editing) {
        await updateContentType(editing.id, { label: editing.label, description: editing.description });
        setEditing(null);
      } else {
        await addContentType(label, description);
        setLabel('');
        setDescription('');
      }
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return <section aria-labelledby="content-types-title" className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-5">
    <div>
      <h3 id="content-types-title" className="text-lg font-semibold text-white">Content types</h3>
      <p className="mt-1 text-sm text-gray-400">Definitions help the AI recognize each format. Edit a label or definition without changing its type value.</p>
    </div>
    <div className="divide-y divide-gray-800">
      {types.map(type => <div key={type.id} className="flex items-start justify-between gap-3 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white">{type.label} <span className="ml-2 text-xs font-normal text-gray-500">{type.value}</span></p>
          <p className="mt-1 break-words text-sm text-gray-400">{type.description || 'No definition yet.'}</p>
        </div>
        <button type="button" disabled={busy} aria-label={`Edit ${type.label} content type`} onClick={() => { setEditing({ ...type, description: type.description || '' }); setError(''); }} className="rounded border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:text-white disabled:opacity-50">Edit</button>
      </div>)}
    </div>
    <form onSubmit={save} className="space-y-3 border-t border-gray-800 pt-4">
      <p className="text-sm font-medium text-white">{editing ? `Edit ${editing.value}` : 'Add a content type'}</p>
      <label className="block space-y-1 text-xs text-gray-400">
        <span>Label</span>
        <input required maxLength={40} disabled={busy} value={editing ? editing.label : label} onChange={event => editing ? setEditing({ ...editing, label: event.target.value }) : setLabel(event.target.value)} className={inputClass} />
      </label>
      <label className="block space-y-1 text-xs text-gray-400">
        <span>Definition</span>
        <textarea rows={2} disabled={busy} value={editing ? editing.description : description} onChange={event => editing ? setEditing({ ...editing, description: event.target.value }) : setDescription(event.target.value)} className={inputClass} />
      </label>
      <div className="flex items-center gap-3">
        <button disabled={busy} type="submit" className={buttonClass}>{busy ? 'Saving…' : editing ? 'Save content type' : 'Add content type'}</button>
        {editing && <button type="button" disabled={busy} onClick={() => { setEditing(null); setError(''); }} className="text-sm text-gray-400 hover:text-white">Cancel</button>}
      </div>
    </form>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
  </section>;
}
