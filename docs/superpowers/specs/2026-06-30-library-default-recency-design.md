# Library Default Recency — Design Spec

**Date:** 2026-06-30
**Status:** Approved design (brainstorm complete) → awaiting spec sign-off
**Scope:** `client/src/pages/LibraryTab.js`, `client/src/components/FilterBar.js`. Pure frontend. No server change. No new dependencies.
**Base branch:** **independent of Targeted Suggestions** — touches only `client/`, so it should ship on its own branch off `main` and can merge anytime.

---

## 1. Context & Problem

The Library tab loads with **empty date filters** (`startDate: '', endDate: ''`, [LibraryTab.js:17-26](../../../client/src/pages/LibraryTab.js)). With no dates set, the server returns **all-time** results. Under "Newest" or "Most Viewed," that surfaces **stale high-view posts from months ago** that are no longer relevant — exactly the "high views, but it's from three months ago" problem. Staff have to manually set a date range every session to get a current view.

## 2. Goals & Non-Goals

### Goals
- Default the Library to the **last 30 days** on load.
- Keep the window **changeable**, with quick presets and a clear **"All time"** escape.

### Non-Goals
- No server-side change (the API already filters on `startDate`/`endDate`).
- No change to sort defaults (stays "Newest") or any other filter.
- No persistence of the user's last-chosen range (out of scope; could be a later nicety).

## 3. Decision

Default `filters.startDate` to **30 days ago** on initial load; `endDate` stays empty (open-ended = up to now). Add a small **range preset** control to the FilterBar — **`30d` / `90d` / `All`** — that sets `startDate` accordingly (`All` clears it). The existing date inputs remain for custom ranges and override the preset.

## 4. Architecture

- **`LibraryTab.js`:** initialize `filters.startDate` to an ISO `YYYY-MM-DD` string for `now − 30 days` via a small pure helper `daysAgoISO(30)`. Everything else in `loadContent` already forwards `startDate`/`endDate` to the API unchanged.
- **`FilterBar.js`:** add a preset `<select>` (or segmented buttons) **Last 30 days / Last 90 days / All time**. Selecting a preset calls `onChange('startDate', value)` (and clears it for "All time"). The preset's displayed value derives from the current `filters.startDate` so manual date edits and the preset stay consistent.
- **Edge cases:** "All time" → `startDate=''` (server returns all). A manual `startDate` that doesn't match a preset shows the preset as "Custom" (or leaves it unselected). Page resets to 1 on any change (existing behavior).

## 5. Testing

Light — this is a default plus a control. Verify via the browser preview: on load the grid shows only posts from the last 30 days; switching to **All time** reveals older posts; a custom date range still works. Optionally a one-line unit test on `daysAgoISO`.

## 6. Summary of Changes

| File | Change |
|------|--------|
| `client/src/pages/LibraryTab.js` | Initialize `filters.startDate` to `daysAgoISO(30)`; add the helper. |
| `client/src/components/FilterBar.js` | Add a 30d / 90d / All-time range preset control wired to `startDate`. |
