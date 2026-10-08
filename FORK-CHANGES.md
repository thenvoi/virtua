# thenvoi/virtua fork changes

Rev-pinned fork consumed by [thenvoi/tjam](https://github.com/thenvoi/tjam) via a
GitHub Release tarball URL pinned by sha512 in `pnpm-lock.yaml` (see tjam's
`apps/desktop/vendor-dependencies.json`). Based on tag `0.53.3`
(`2d8617e8fcadce63f3eefd37abd89d54e582f6f8`).

Band previously vendored `virtua@0.50.0` inside tjam (`apps/desktop/src/lib/virtua`,
commits `5fe3139f9`, `c05b2211e`, `c26229243`). This fork gives those changes a
home with upstream's own build, tests, and upgrade path. The delta numbering
below is **Band's vendored README numbering** (tjam
`apps/desktop/src/lib/virtua/README.md` §"Local changes"), preserved so review
history stays traceable.

Upgrade procedure: the weekly `jam-rebase-patch` workflow replays the fork-only
commits onto the newest upstream tag as `jam-<X.Y.Z>` (compile- and test-checked).
Taking an upgrade in tjam = cut `v<X.Y.Z>-jam.1` on that branch (the release
workflow gates and publishes the tarball), then bump tjam's pin + inventory.
A tjam `fork-freshness` watcher files an issue when a staged branch outruns the
pin.

## 1–3. WKWebView deferral, backlog cap, start-edge release — RE-ADDED (F7)

Three interacting changes that make Band's conversation feed survive WKWebView's
revert of mid-gesture `scrollTop` writes: delta 1 defers size corrections in any
WebKit — not only iOS — until the gesture ends; delta 2 caps the deferred
backlog at one viewport; delta 3 releases it early at the start edge. The cap
and the release exist only for the deferral, so the three land or revert
together.

History: Band's vendored copy carried these as changes 1–3 on `virtua@0.50.0`
(tjam `apps/desktop/src/lib/virtua/README.md` §"Local changes"). The first port
to 0.53.3 retired them in favor of upstream PR
[#942](https://github.com/inokawa/virtua/pull/942), which applies mid-range
corrections with relative `scrollBy` "not to overwrite concurrent scrolling"
(closing upstream issue #367), keeping absolute `scrollTo` writes only at the
scroll edges. The owner's packaged macOS A/B on his 120Hz display (2026-10-08;
tjam `docs/plans/virtua-fork-dependency.md` Appendix C) showed #942 does not
cover the symptom class while a flick decelerates and new rows measure — the
1-frame grow-and-settle appeared on nearly every stroke against the vendored
baseline's roughly one in five. That invoked the F7 fallback: these three
commits, released as `v0.53.3-jam.2`.

Implementation on this branch:

- **Delta 1** (`core/environment.ts`, `core/store.ts`, `core/observer.ts`):
  `isWebKit` — every WebKit engine, Chromium and Edge excluded by name —
  joins the deferral guard via the wheel/touch seam of a new
  `ACTION_USER_GESTURE` reported by the scroll observer. A Tauri desktop app
  runs WKWebView, whose user agent matches neither branch of upstream's
  iOS-only check. Keying the desktop branch on the gesture, not on scroll
  direction, is the port's one adaptation to the 0.53.3 structure: 0.53.3's
  own suites encode #942's semantics for PROGRAMMATIC scrolls, which must
  keep immediate relative writes; WKWebView reverts only writes made during
  a user gesture — exactly when the observer sees wheel/touch activity. iOS
  keeps upstream's direction-based branch unchanged.
- **Delta 2** (`core/store.ts`): a parked correction is height the list does
  not yet know it has. Unbounded it reached thousands of pixels — the scroll
  bottomed out short of the real top while offsets mapped onto rows that were
  not on screen. Past one viewport, the backlog is applied immediately.
- **Delta 3** (`core/store.ts`): while corrections are parked the content is
  shorter than reality, so the scroll can stop at a false ceiling mid-message
  and need a second gesture. Release fires at the start edge only, with no
  direction test and in native mode only — deliberately narrower than
  upstream's disabled attempt in the same `ACTION_SCROLL` branch, which
  broke reverse infinite scrolling. The mode gate is this port's adaptation:
  a frozen-range (smooth-scroll) park must survive until scroll end per
  #942, as must delta 2's cap, which likewise applies only to the gesture
  backlog.

Gated by:

- **P7a (deterministic, this repo):** `src/jam-corrections.browser.spec.tsx`
  and `src/react/jam-corrections.browser.spec.tsx` prove on Chromium, Firefox,
  and WebKit that the correction branches — mid-range relative (#367),
  absolute-top, absolute-end — keep the reader's anchor row still, with
  suppression probes proving each can fail. #942's relative application
  composes with the deferral; the P7a set is what adjudicates the interaction.
- **P7b (native, tjam):** the packaged macOS A/B that triggered this port
  must show the deceleration symptom on `v0.53.3-jam.2` at or below the
  vendored baseline's frequency.

## 4. `react/Virtualizer.tsx` — cache each rendered row

Upstream calls the item render function fresh for every mounted index on every
re-render — a fresh element object every call defeats `ListItem`'s memo
unconditionally, so every mounted row reconciles on every native scroll/resize
event even when its rendered output is identical. The cache retains each
render function's result per mounted index across re-renders where the render
function itself is the same reference, and resets wholesale the moment it
changes — which the render prop's caller already does whenever anything a row
depends on changes. Bounded to the indices actually mounted each render, so it
cannot grow with scroll. Upstream's `"use no memo"` opt-out stays.

Tests: `react/Virtualizer.spec.tsx` (element-cache suite),
`react/jam-corrections.browser.spec.tsx` (identity across a
correction-producing resize, WebKit included).

## 5. `core/layouts/list.ts` + `core/store.ts` + `react/Virtualizer.tsx` — per-index size estimator

Upstream `itemSize` is one flat scalar for every unmeasured row.
`VirtualizerProps.itemSize` now also accepts `(index: number) => number`; the
list layout caches each call's result in an estimates array kept separate from
measured sizes (so `isUnmeasuredItem` still means "not yet
ResizeObserver-measured", not "estimated") and never re-invokes the callback for
an index it already priced. Length changes price added/removed indices through
the estimator instead of a flat multiply, so shift compensation during a prepend
or trim reflects per-index guesses. Swapping the estimator invalidates cached
estimates from the first still-unmeasured index and recompensates through the
existing jump path (`ACTION_ITEM_SIZE_ESTIMATOR_CHANGE` = 10 in the fork's
action enum; 9 is upstream's `ACTION_RELAYOUT`) — an estimate change is a
geometry mutation exactly like a real resize. A non-finite or non-positive
callback result falls back to the layout's configured default size, never a
caller-specific number. Automatic estimation is exclusive with the callback.

**Seam (F1):** `Layout.$setEstimator?` (`core/layouts/types.ts`), implemented by
the list layout; the store no-ops the action on layouts without it. The React
component orders the estimator swap against the length change (length-change
first for a prepend or shrink, estimator first for a plain growth) so an
estimator closure built against post-shift data never prices the old index
space.

Tests: `core/layouts/list.spec.ts` (estimator + setLength pricing suites),
`core/store.spec.ts` (geometry compensation + dispatch ordering),
`react/jam-corrections.browser.spec.tsx` (swap during scroll, WebKit included).

## 6. `core/store.ts` — identity remap of measured sizes

`VirtualizerHandle.remapItems({previousLength, order})` repairs the raw
index-to-size cache in place; `isUnmeasuredItem(index)` exposes measurement
state. The caller supplies identity order only: each new index points to its
previous index or `-1`. Same-length changes use the store's current raw sizes;
length changes use the exact retained pre-change window. The store rejects
invalid windows and automatic item-size estimation. Successful remapping clears
the flushed-jump freeze and frozen range, resets native scroll mode, and
notifies asynchronously. A pending or immediate jump survives only when the
remap completes an in-flight `ACTION_ITEMS_LENGTH_CHANGE` shift/growth
transaction, detected by `_scrollMode` rather than length alone, or is a
same-length identity permutation that moves no row. Any other reorder or filter
discards the jump — it described a delta for the row-to-index mapping the remap
replaced.

The vendored rationale cited the WebKit deferral as the "most often" source of
the stale jump (delta 1); that reference is historical — any parked correction
(estimator swap deferred by upstream's iOS/smooth-scroll paths) qualifies
identically, and the contract itself is unchanged.

**Seam (F1):** `Layout.$remapSource?` / `Layout.$replaceSizes?`
(`core/layouts/types.ts`), implemented by the list layout; layouts without the
seam reject the remap (the consumer's remount fallback stays intact).

Tests: `core/store.spec.ts` (remap + stale-jump suites),
`core/layouts/list.spec.ts` (estimate discard),
`react/jam-corrections.browser.spec.tsx` (remap after a prepend, WebKit
included).

## Automation — `jam-rebase-patch.yml`, `jam-release.yml`

- **`jam-rebase-patch.yml`** (weekly + dispatch): fetch upstream tags, newest
  semver tag, replay the fork-only commits (`HEAD --not --remotes=upstream`)
  onto it as `jam-<X.Y.Z>`, then `npm ci`, `npx playwright install
  --with-deps`, `npm run tsc`, `npm test`, `npm run test:browser`. A clean run
  means the upgrade branch is ready before anyone needs it; red means upstream
  drifted under a delta — resolve by hand, not mid-upgrade. Fork-only commits
  are derived, never stored as files, so the replay cannot drift from the
  branch's reality. This file lives on the fork's DEFAULT branch so the
  schedule is honored (GitHub disables cron workflows on non-default fork
  branches).
- **`jam-release.yml`** (on tag `v*-jam.*`): the same gate, then an uncommitted
  version stamp from the tag, `npm run build`, `npm pack`, and attach
  `virtua-<ver>-jam.<n>.tgz` to the GitHub Release for the tag, printing its
  sha512. A red test step produces no release. The release runner provisions
  its own browsers. Releases are immutable: a bad one is superseded by a new
  `-jam.<n>` tag, never replaced in place.
- **`check.yml`** (upstream's workflow, one-line fork delta): added
  `workflow_dispatch` so the full gate — tsc, unit, `test:browser --retry=2`
  across Chromium/Firefox/WebKit — can run on a `jam-<ver>` branch, which is
  never `main` and therefore never triggers the push event. Used as the
  successor P1 gate after spec-only commits (the release tarball ships no
  specs, so a branch whose delta set matches a released one needs no
  re-release — only this green run).
- **`.size-limit.json`** (fork-only config delta): every entry's budget is the
  upstream number plus measured delta growth (~0.2–0.4 kB brotlied) plus
  0.1 kB headroom. The correction/estimator code lives in shared `core/`, so
  all 17 bundles grew; upstream's numbers were never re-baselined on the fork
  because `check.yml` first ran on a `jam-<ver>` branch on 2026-10-08. On a
  rebase where growth shifts, re-measure with `npm run build && npm run
  size` and bump, never delete an entry.
