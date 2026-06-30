// Date helpers for filtering.

// Returns the date `days` ago as a `YYYY-MM-DD` string (matches <input type="date">
// and the API's startDate/endDate params). Local-date based so it lines up with
// what the user sees in the date picker.
export function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Named presets for the Library date window.
export const DATE_PRESETS = [
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All time', days: null },
];

// Given the current startDate filter, figure out which preset it represents
// (so the dropdown stays in sync with manual date edits).
export function presetForStartDate(startDate) {
  if (!startDate) return 'all';
  for (const p of DATE_PRESETS) {
    if (p.days != null && startDate === daysAgoISO(p.days)) return p.value;
  }
  return 'custom';
}
