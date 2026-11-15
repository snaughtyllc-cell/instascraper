const { validateTypeLabel } = require('./content-types');

const DEFAULT_LOOK_TAGS = [
  ['hair', ['blonde', 'brunette', 'black-hair', 'red-hair', 'dyed-hair']],
  ['aesthetic', ['emo', 'alt', 'e-girl', 'girl-next-door', 'glam', 'gym', 'cottagecore']],
  ['setting', ['bedroom', 'car', 'outdoors', 'studio']],
].flatMap(([category, values]) => values.map((value, sort_order) => ({
  value, label: value.replace(/-/g, ' ').replace(/^./, letter => letter.toUpperCase()), category, sort_order,
})));

function parseTagList(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(value => typeof value === 'string').map(value => value.trim().toLowerCase()).filter(Boolean))];
  } catch { return []; }
}

function cleanModelLookTags(tags, vocab) {
  if (!Array.isArray(tags)) return [];
  const known = new Set(vocab.map(tag => typeof tag === 'string' ? tag : tag.value));
  return parseTagList(JSON.stringify(tags)).filter(tag => known.has(tag));
}

function validateLookTagInput({ label, category } = {}) {
  if (!['hair', 'aesthetic', 'setting', 'custom'].includes(category)) return { ok: false, error: 'Choose a valid category' };
  const validated = validateTypeLabel(label);
  return validated.ok ? { ...validated, category } : validated;
}

async function seedLookTags(db) {
  for (const tag of DEFAULT_LOOK_TAGS) {
    await db.query(`INSERT INTO look_tags (value, label, category, sort_order, created_at)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (value) DO NOTHING`,
    [tag.value, tag.label, tag.category, tag.sort_order, new Date(0).toISOString()]);
  }
}

module.exports = { DEFAULT_LOOK_TAGS, parseTagList, cleanModelLookTags, validateLookTagInput, seedLookTags };
