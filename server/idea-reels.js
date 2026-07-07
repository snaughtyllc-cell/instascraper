function parseSourceShortcodes(sourcePostIds) {
  const raw = String(sourcePostIds || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const item of raw) {
    const m = item.match(/(?:reels?|p)\/([A-Za-z0-9_-]+)/) || item.match(/^([A-Za-z0-9_-]{5,})$/);
    if (m && m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
module.exports = { parseSourceShortcodes };
