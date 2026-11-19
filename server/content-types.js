const DEFAULT_CONTENT_TYPES = [
  { value: 'talking', label: 'Talking' },
  { value: 'dance', label: 'Dance' },
  { value: 'skit', label: 'Skit' },
  { value: 'snapchat', label: 'Snapchat' },
  { value: 'omegle', label: 'Omegle' },
  { value: 'osc', label: 'OSC' },
  { value: 'lipsync', label: 'Lip sync' },
  { value: 'reveal', label: 'Reveal' },
];

const CONTENT_TYPE_DESCRIPTIONS = {
  talking: 'The person speaks their own words to camera; the voice is theirs and live (storytime, rant, opinion, advice).',
  lipsync: 'The person mouths along to pre-recorded music, a song or trending audio that is not their own speech.',
  dance: 'The main action is dancing, choreography or rhythmic body movement to music.',
  skit: 'An acted comedy scene, joke or character performance with a setup or scenario.',
  snapchat: 'A casual Snapchat-style selfie clip, often using face filters, lenses or quick personal updates.',
  omegle: 'A recorded random video-chat interaction with another participant, often in a split-screen layout.',
  osc: 'On-screen captions or text carry the main message while the person reacts, poses or performs silently.',
  'thirst-trap': 'The main focus is a deliberately flirtatious or alluring pose or expression. Tattoo, body or outfit reveals belong in Reveal.',
  reveal: 'The clip builds to a reveal of a tattoo, body or outfit, often as a double take, a turn to camera or a cut from covered to shown.',
  grwm: 'The person gets ready on camera, showing steps such as makeup, hair, skincare or choosing an outfit.',
  lifestyle: 'Everyday activities, routines, outings or personal moments are the main focus.',
  fitness: 'Exercise, workouts, sports training or demonstrations of fitness movements are the main focus.',
  pov: 'A point-of-view scenario casts the viewer or performer in a specific relatable situation or role.',
};

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

function validateContentTypeInput(input, { partial = false } = {}) {
  const body = input || {};
  const hasLabel = Object.prototype.hasOwnProperty.call(body, 'label');
  const hasDescription = Object.prototype.hasOwnProperty.call(body, 'description');
  if (partial && !hasLabel && !hasDescription) return { ok: false, error: 'Label or description is required' };
  const fields = {};
  if (!partial || hasLabel) {
    const label = validateTypeLabel(body.label);
    if (!label.ok) return label;
    fields.label = label.label;
    if (!partial) fields.value = label.value;
  }
  if (hasDescription) {
    if (body.description !== null && typeof body.description !== 'string') {
      return { ok: false, error: 'Description must be text or null' };
    }
    fields.description = body.description === null ? null : body.description.trim();
  } else if (!partial) fields.description = null;
  return { ok: true, ...fields };
}

async function seedContentTypes(db) {
  for (let i = 0; i < DEFAULT_CONTENT_TYPES.length; i++) {
    const t = DEFAULT_CONTENT_TYPES[i];
    // ON CONFLICT keeps this idempotent on both Postgres and the sqlite test adapter
    await db.query(
      'INSERT INTO content_types (value, label, sort_order, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (value) DO NOTHING',
      [t.value, t.label, i, new Date(0).toISOString()]
    );
  }
  for (const [value, description] of Object.entries(CONTENT_TYPE_DESCRIPTIONS)) {
    await db.query('UPDATE content_types SET description = $1 WHERE value = $2 AND description IS NULL', [description, value]);
  }
}

module.exports = { DEFAULT_CONTENT_TYPES, CONTENT_TYPE_DESCRIPTIONS, slugifyTypeLabel, validateTypeLabel, validateContentTypeInput, seedContentTypes };
