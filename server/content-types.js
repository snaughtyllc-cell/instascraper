const DEFAULT_CONTENT_TYPES = [
  { value: 'talking', label: 'Talking' },
  { value: 'dance', label: 'Dance' },
  { value: 'skit', label: 'Skit' },
  { value: 'snapchat', label: 'Snapchat' },
  { value: 'omegle', label: 'Omegle' },
  { value: 'osc', label: 'OSC' },
];

function slugifyTypeLabel(label) {
  return String(label || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validateTypeLabel(label) {
  const trimmed = String(label || '').trim();
  if (!trimmed) return { ok: false, error: 'Label is required' };
  if (trimmed.length > 40) return { ok: false, error: 'Label too long (max 40)' };
  const value = slugifyTypeLabel(trimmed);
  if (!value) return { ok: false, error: 'Label must contain letters or numbers' };
  return { ok: true, value, label: trimmed };
}

module.exports = { DEFAULT_CONTENT_TYPES, slugifyTypeLabel, validateTypeLabel };
