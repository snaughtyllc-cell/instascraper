# Library "Faster Triage" — Design Spec

**Date:** 2026-06-30
**Status:** Approved design (brainstorm) → awaiting spec sign-off
**Scope:** `server/index.js` (one new bulk endpoint + an `untagged` filter on `GET /content`), `client/src/pages/LibraryTab.js`, `client/src/components/FilterBar.js`, `client/src/components/ContentCard.js`, new `client/src/components/BulkActionBar.js`, `client/src/api.js`. No new dependencies.
**Base branch:** `library-faster-triage`, off current `main` (PRs #1–#6 merged & live). Independent of the engagement/collab work.
**Sub-project:** Sub-D of the InstaScraper roadmap (Library UX). Sub-C (scheduling/reach) is a separate later track.

---

## 1. Context & Problem

The Library is the daily **triage loop**: VAs scan recent reels and, per reel, set a **tag** (`recreate`/`reference`/`skip`), optionally a **content-type** and **notes**, and **archive** junk — then export the `recreate` set for the models to recreate. Verified against the current code ([LibraryTab.js](../../../client/src/pages/LibraryTab.js), [FilterBar.js](../../../client/src/components/FilterBar.js), [ContentCard.js](../../../client/src/components/ContentCard.js)), the loop has three volume/findability frictions:

1. **Every action is one-card-at-a-time.** Tagging or archiving 100 reels means 100 individual clicks. The Suggested tab gained multi-select bulk actions in PR #4; the Library never did.
2. **Caption search is unreachable.** `GET /content` already supports `search` (`caption ILIKE`, [index.js:155](../../../server/index.js)), but there is **no search input** in the FilterBar — so VAs cannot find a reel by hook/keyword.
3. **No way to focus on the unreviewed backlog.** There is no "show only untagged" filter, so a VA cannot see (or work) just the reels still needing a decision.

A minor polish gap: the grid **swaps content with no loading feedback** (`loadContent` replaces `posts` silently), which reads as jank on prod latency.

## 2. Goals & Non-Goals

### Goals
- **Bulk multi-select:** select many reels and **Tag / Archive-Unarchive / Set content-type** in one action.
- **Caption search:** expose the existing `search` API as a debounced input.
- **Untagged focus:** filter to reels with no tag, with the post-count showing the remaining backlog.
- **Loading state:** lightweight feedback while content loads.

### Non-Goals (deferred — logged as future Library work)
- Browsing-at-scale changes (infinite scroll / jump-to-page / compact list view).
- Richer sort (min-ER, "trending" = recent + high-ER).
- Cross-session filter persistence.
- Inline video preview.
- Bulk **notes** (free-text bulk-set is not a real workflow) and bulk **delete** (Library has no per-card delete; archive is the lever).

## 3. Decisions (from brainstorm)

| Decision | Choice |
|----------|--------|
| Bulk surface | Per-card checkbox + sticky `BulkActionBar`, mirroring the Suggested tab's pattern. Per-card actions stay. |
| Bulk endpoint | **One** generic `POST /content/bulk` `{ ids, action, value }` (not three routes), reusing the existing per-action allow-lists. |
| Bulk SQL | Dynamic `id IN ($2,$3,…)` placeholder list (portable across PG + the SQLite shim), **not** Postgres-only `= ANY()`. |
| "Untagged" surface | An **option in the existing tag `<select>`** (value `__untagged__`), not a separate toggle — fewer controls. |
| Search | Debounced (~300 ms) input in FilterBar; no server change (API already filters `caption ILIKE`). |
| Selection lifetime | Selection clears on any filter change and on page change (stale ids must not carry across result sets). |

## 4. Architecture

### 4a. Bulk endpoint — `POST /content/bulk` (`server/index.js`)
Body `{ ids: number[], action: 'tag'|'archive'|'content-type', value }`.
- Coerce `ids` to **positive integers**, drop the rest; empty → `{ updated: 0 }` without a query.
- Switch on `action`, reusing the **existing** allow-lists verbatim:
  - `tag`: `value ∈ ['recreate','reference','skip', null]` → `SET tag = <value>`.
  - `content-type`: `value ∈ ['talking','dance','skit','snapchat','omegle','osc', null]` → `SET content_type = <value>`.
  - `archive`: `value` truthy/falsy → `SET archived = <value ? 1 : 0>`.
  - unknown `action`, or `value` not in the allow-list → `400 { error }`.
- One UPDATE: `UPDATE posts SET <col> = $1 WHERE id IN ($2,$3,…,$n)` with `[value, ...ids]`. Returns `{ updated: result.rowCount }`. (The dual-mode shim rewrites `$n`→`?`; better-sqlite3 supports `IN (?,?,…)`.)

### 4b. `untagged` filter — `GET /content` (`server/index.js`)
Add a query param `untagged`. When `untagged === 'true'`, push `(tag IS NULL OR tag = '')` to the WHERE list. It is independent of `tag` (the client sends one or the other). The existing `total`/`totalPages` already reflect the filtered set, so the backlog count is free.

### 4c. Selection + loading state — `LibraryTab.js`
- `selected` as a `Set<number>` of post ids; `toggleSelect(id)`, `selectAllOnPage()` (adds all `posts` ids), `clearSelection()`. `handleFilterChange` and `setPage` both **clear `selected`**.
- `loading` boolean: set `true` before `getContent`, `false` in `finally`. Render a lightweight overlay/skeleton when true (dim grid + spinner).
- `search` and the untagged option wired into `loadContent`: `if (filters.search) params.search = filters.search`; if `filters.tag === '__untagged__'` send `params.untagged = 'true'` (and **omit** `tag`), else send `tag` as today.
- `handleBulkAction(action, value)`: call `bulkUpdateContent([...selected], action, value)`, then `loadContent()` + `loadCreatorTypes()` + `clearSelection()`. Wrap in try/catch (matches existing handler style); on error, surface a small inline message.

### 4d. Card checkbox — `ContentCard.js`
New props `selected: boolean`, `onToggleSelect: (id) => void`. Render a checkbox overlay on the thumbnail (top-left, near the ER badge), styled for the dark theme; selected state gives the card a ring/highlight. All existing per-card controls remain unchanged.

### 4e. `BulkActionBar.js` (new)
Props: `count`, `onTag(tag)`, `onArchive(archived)`, `onSetType(type)`, `onSelectAll`, `onClear`. A **sticky** bar (only when `count > 0`): "`N selected`", a **Tag** control (recreate/reference/skip), **Archive** + **Unarchive**, a **Set type** dropdown (the 6 types), **Select all on page**, **Clear**. Visual language matches the Suggested tab's bulk bar.

### 4f. FilterBar + api (`FilterBar.js`, `api.js`)
- FilterBar: a **search `<input>`** (debounced ~300 ms via a local `searchText` state synced to `filters.search`), and an **"Untagged"** `<option>` added to the tag `<select>`.
- api.js: `export const bulkUpdateContent = (ids, action, value) => api.post('/content/bulk', { ids, action, value });`

## 5. Data Model
No schema change. Reuses `posts.tag`, `posts.content_type`, `posts.archived`, `posts.caption`.

## 6. Configuration (env)
None.

## 7. Observability
The bulk endpoint logs one line per call: `[Content] bulk action=<a> value=<v> ids=<n> updated=<m>`.

## 8. Error Handling
- Bulk: invalid `action`/`value` → `400`; non-integer ids dropped; empty ids → `{ updated: 0 }` (no query). A DB error returns the standard 500 (existing `wrapAsyncRoutes`/handler pattern).
- Client bulk handler try/catch; a failed bulk call shows an inline error and leaves selection intact so the VA can retry.
- Search/untagged are plain filters; no new failure modes.

## 9. Testing (`node:test`, sqlite in-memory, matching existing `server/*.test.js`)
- **Bulk validation:** unknown `action` → 400; `tag`/`content-type` value outside the allow-list → 400; `null` value accepted for tag and content-type.
- **Bulk update:** given 3 ids, `action='tag', value='skip'` updates exactly those rows and returns `{ updated: 3 }`; non-integer/garbage ids are dropped; empty ids → `{ updated: 0 }` and no row changes.
- **Bulk archive:** `value` truthy → `archived = 1`; falsy → `archived = 0`.
- **`untagged` filter:** with mixed tagged/untagged rows, `untagged=true` returns only `tag IS NULL OR tag=''`; `tag=recreate` still returns only that tag (no regression).
- **Portability:** the `IN ($2,$3,…)` UPDATE runs under the sqlite shim (placeholder rewrite) — covered by the bulk-update test running on in-memory sqlite.
- Client (browser-verified, no unit harness): select → bulk-tag updates the cards; search narrows the grid; "Untagged" shows only untagged with the count; loading indicator appears during fetch.

## 10. Risks & Verification
1. **Stale selection across result sets.** Mitigated: selection clears on filter/page change (§4c). Verify by selecting, then changing a filter → selection empties.
2. **Bulk SQL portability.** Mitigated by the dynamic `IN (…)` placeholder approach + a sqlite test. Verify the bulk-update test passes under `node --test`.
3. **Debounce correctness.** A too-eager search fires per keystroke; the ~300 ms debounce + page-reset-to-1 must not drop the final keystroke. Verify in the browser.
4. **`null` over the wire.** JSON `null` for clearing a tag/type must pass the allow-list (`includes(null)` is true). Verify in the bulk validation test.

## 11. Summary of Changes
| File | Change |
|------|--------|
| `server/index.js` | `POST /content/bulk` (generic, allow-list reuse, `IN (…)` UPDATE); `untagged` filter on `GET /content`. |
| `client/src/pages/LibraryTab.js` | `selected` Set + `loading` state; search/untagged wiring; bulk handler; render `BulkActionBar`. |
| `client/src/components/FilterBar.js` | Debounced search input; "Untagged" tag option. |
| `client/src/components/ContentCard.js` | Selection checkbox + `selected`/`onToggleSelect` props. |
| `client/src/components/BulkActionBar.js` | New sticky multi-select action bar. |
| `client/src/api.js` | `bulkUpdateContent(ids, action, value)`. |
| `server/*.test.js` | Bulk validation/update/archive + `untagged` filter tests. |
