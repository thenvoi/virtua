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

Revision (jam.3): the owner's confirmation against the jam.2 pin —
the gesture-keyed hold releases at scroll-end, but on WKWebView the
scroller is not settled when it does: the momentum tail keeps the viewport
moving after lift-off, rows the deceleration reveals measure mid-tail, and
their corrections land where WKWebView reverts them — the same
drop-and-return, at gesture end rather than mid-stroke. Delta 1's desktop
WebKit condition is therefore revised from gesture-keyed to
**settle-keyed**: the hold spans the gesture _and_ the tail, parking until
the position is stable — no delivered scroll-position delta for the
stability window. Jam.3 used the observer's 150 ms scroll-end debounce as
that window, one event for "settled" and "scroll ended". The owner's A/B
against the corrected build showed the residual that leaves open: on a
120 Hz tail the DELIVERED events can gap past 150 ms, the timer fires
mid-gap, and the release lets a straggler correction land after the hold
is gone. For the first corrected build the two windows were separated: the
debounce stayed 150 ms for everything else, while a fire landing with the
settle hold ACTIVE re-armed once for the remainder of a 300 ms stability
window. The owner's further A/B then exposed what a fixed window cannot
hold: his trackpad tails run well past a second, delivered events gap past
150 ms mid-tail — where his ~50px shift is expected to come from, pending
the paired native trace (§8, gate G5) — and a
flush landing the moment deceleration ends gets eaten by the next
gesture's rubber-band (the suppressed-overshoot flick). Jam.3's final form
is therefore EVENT-DRIVEN — `SETTLE_STABILITY` (300 ms) of SIGNAL silence,
the deadline sliding with every wheel or scroll event, no fixed total
budget — with the release gated on a hand having been on glass this
session and the store's settle hold (see §8 for the final write-discipline
contract these gates serve).

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
  keeps upstream's direction-based branch unchanged. The jam.3 revision adds
  a settle arm to the same seam (`store._awaitingSettle`): a gesture release
  with the position still changing keeps parking through the tail, a new
  gesture re-takes the hold, and scroll-end — the stability window elapsing —
  releases once through the existing flush path. The jam.3 final revision
  turns that release into a two-condition gate, evaluated at every
  scroll-end timer fire: (1) no hand on glass — the gate enters only for a
  session that reported a user gesture since the last scroll-end
  (`gestureSeen`, set at the observer's gesture-ON seam sites, cleared only
  by the dispatch), and every wheel or scroll event slides the deadline, so
  a gesture re-engaging mid-window — a rubber-band flick — defers the flush
  with it; (2) `SETTLE_STABILITY` (300 ms) of SIGNAL silence — scroll OR
  wheel, no fixed total budget: a 1 s+ tail stays held and settles ~window
  after its LAST event. A correction merging inside the window rides the
  window's single at-rest re-sync — accepted epoch semantics: the
  merge-restart first sketched for this gate was adjudicated a non-item,
  because compensating before the window closes only risks racing a
  still-arriving tail (the pre-fix flicker is exactly that write racing
  motion), while a restart rule would defer the invisible at-rest re-sync
  and starve it on a continuously measuring list. The hold term is
  `store.$isSettleHeld` — armed AND native mode, matching the park
  semantics exactly. Each gate term is load-bearing: the hold ARM keys on
  movement alone (a raw programmatic `scrollTop` step also releases into it
  — harmlessly pre-fix, same-tick), so without the session term the webkit
  compensation and estimator suites land their releases 150 ms late;
  without the engine term the #942 engines get held too; without the wheel
  fold-in the gappy wheel-only streams fire mid-gesture (the report above
  hands the park to the gesture flag while wheeling, which is why the fold
  keys on the SESSION, not the hold flag). The wheel pulse within the
  window after the last delivered position still re-reports the gesture (a
  dropped-frame debounce gap on a 120 Hz display must not end the hold
  mid-tail; programmatic scrolls dispatch no wheel events, so #942 is
  untouched). The settle term is confined to native scroll mode; marked
  imperative operations keep their #942 contract, and deltas 2's cap and
  3's start-edge release apply to the tail backlog exactly as to the
  gesture backlog — with §8 re-scoping both.
- **Delta 2** (`core/store.ts`): a parked correction is height the list does
  not yet know it has. Unbounded it reached thousands of pixels — the scroll
  bottomed out short of the real top while offsets mapped onto rows that were
  not on screen. Past one viewport, the backlog is applied immediately — an
  ESCAPE, not a per-write limit: the whole accumulated correction commits
  in one write and the backlog clears, and no per-write cap was ever
  introduced. §8 re-scopes WHEN it may fire: the escape commits at idle
  only; a backlog that grows past the viewport during a gesture parks
  whole and lands, full magnitude, in the single rest write (burst and
  programmatic escapes unchanged).
- **Delta 3** (`core/store.ts`): while corrections are parked the content is
  shorter than reality, so the scroll can stop at a false ceiling mid-message
  and need a second gesture. Release fires at the start edge only, with no
  direction test and in native mode only — deliberately narrower than
  upstream's disabled attempt in the same `ACTION_SCROLL` branch, which
  broke reverse infinite scrolling. The mode gate is this port's adaptation:
  a frozen-range (smooth-scroll) park must survive until scroll end per
  #942, as must delta 2's cap, which likewise applies only to the gesture
  backlog. SUPERSEDED by §8 (jam.3 final, EDGE-START): at the start edge
  a correction applies geometry only, during a gesture and at rest alike,
  AND the parked debt is cleared there LIVE — the reader's own scroll
  event onto the edge removes it from the item-offset mapping
  (geometry-only invalidation), the settle/burst flush clearing being the
  backstop — so offsets return to true geometry at edge-reach, not
  settle-lagged (the debt's duty is one-shot anchor preservation at the
  layout change; the free scroll to the edge voids it). The false ceiling
  is lifted by the rest commit, never by a write at or into the elastic
  region. The paragraph above describes jam.2's shipped shape.

Gated by:

- **P7a (deterministic, this repo):** `src/jam-corrections.browser.spec.tsx`
  and `src/react/jam-corrections.browser.spec.tsx` prove on Chromium, Firefox,
  and WebKit that the correction branches — mid-range relative (#367),
  absolute-top, absolute-end — keep the reader's anchor row still, with
  suppression probes proving each can fail. #942's relative application
  composes with the deferral; the P7a set is what adjudicates the interaction.
  The jam.3 momentum-tail case drives the seam with plain-Event touch pulses
  and delivered position deltas, and asserts on the WebKit witness timeline
  that no flush precedes the stability window and exactly one anchored flush
  follows it; the jam.3 final gap case inserts a delivered-event gap past
  the plain debounce and asserts the hold survives it — WebKit commits the
  two deliveries as ONE write after a silent scroll-end, while
  Chromium/Firefox show the plain-debounce marker already present and both
  deliveries written immediately (#942 intact, the gate's engine term
  pinned). The dense-tail case rides a ~1 s pulse stream with one legacy
  gap mid-way and a late measurement inside the trailing window: no
  release across the whole tail, ONE merged commit only after signal
  silence AND backlog stillness (the revision-restart, red under its
  removal); the preemption case streams wheel-only gestures (the
  rubber-band shape — untrusted wheels made cancelable, pure signal, and
  note the gesture re-report keeps the HOLD cleared across such a stream,
  which is why the fold keys on session not hold) and asserts ZERO writes
  mid-stream, one flush after it rests (red under removal of either the
  fold or the deadline slide). `store.spec.ts` guards pin
  park-through-the-tail, the single settle flush, the settle-arm
  reset/re-derivation, `$isSettleHeld`'s exact agreement with the park
  condition, and `$jumpRevision`'s tick-economy (backlog mutations only).
  Forcing the settle term false reddens the tail cases; gate off reddens
  gap + dense (chromium inert as control); engine term off reddens the gap
  case on chromium; session term off reddens the webkit programmatic-step
  cases (compensation lazy-content scroll-up, react estimator-swap — the
  #942-era suites that pin plain-debounce release for raw scrollTop
  steps); fold off reddens the preemption case mid-stream.
- **P7b (native, tjam):** the packaged macOS A/B that triggered this port
  must show the deceleration symptom on `v0.53.3-jam.3` at or below the
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

## 7. `core/store.ts` + `core/observer.ts` — batched re-point burst (F8)

Room switching re-points/remounts the list and commits a whole batch of size
corrections with no gesture at all. Deltas 1–3 key the deferral on the user
gesture (and, from jam.3, the settle hand-off), so that batch is held by
nothing — the scroll observer never arms the gesture seam for a remount, and
each ResizeObserver delivery wrote its correction separately: the visible
jump on a room switch. Delta 7 batches the non-gesture transaction instead.
A successful remap (`$remapItems`) arms a **burst** park: the wave's
corrections are added to the same pendingJump the gesture hold uses, capped
by delta 2 (an unknown-height backlog is capped whatever fills it), and the
scroll observer — which owns all the timing so the store stays synchronous —
re-arms a quiescence window on every store update while the burst is pending
and dispatches `ACTION_BURST_SETTLED` once the wave goes quiet for the same
stability constant as the scroll-end debounce — the first arm spans two
windows, so a frame-lagged first delivery cannot end the transaction before
its first batch. The backlog then lands as **one anchored commit** through
the existing single flush path.

Two invariants hold the boundary. Ordinary in-place resizes during scroll
never carry the burst flag, so they stay on #942's immediate path — the
vehicle is the remap transaction, not the engine. And a burst release must
not preempt a live hold: if a WebKit gesture/settle park or a frozen-range
(smooth-scroll) park still owns the release, `ACTION_BURST_SETTLED` leaves
the backlog parked and that release commits it once, so a burst landing
mid-tail or mid-smooth-scroll yields a single write, never two. The reverse
direction also holds (jam.3, from the independent review): a scroll-end
timer armed BEFORE a remap can fire while the wave is still landing, and a
live burst owns its release — scroll-end neither flushes the partial
backlog nor disarms the burst (its state resets still run, so a live hold
releases at the position's settle); whichever timer quiesces first, the
merged backlog commits exactly once. A rejected remap never arms. Consumer
remounts that REJECT the remap (layout without the seam, estimation active,
invalid window) keep the consumer's anchor-restore flow — batching belongs
to the remap vehicle.

Tests: `core/store.spec.ts` (burst batch, engine-agnostic, release-
precedence + scope guards, and the overlapping-timer ownership cases above)
and P7a cases in `src/jam-corrections.browser.spec.tsx` (the two-delivery
burst commits as ONE relative write on every engine; the straddle case
fires a scroll-end mid-wave through the wrapped-store seam and asserts one
merged write strictly after the scroll-end marker, after POLLING its row
precondition — the buffer extension a scroll arms renders a frame late on
Firefox, which `--retry` launders into a false green; a focused no-retry
run across engines is what makes mount-timing cases honest).
Outcome
assertions are viewport-relative — the no-motion burst compares the anchor against its
own `before` (no deliberate travel in the window), and the momentum case
against `before` plus the test's own pulse bookkeeping (no growth term):
with correction writes recorded but not forwarded, each outcome test turns
red by the full displacement, which the earlier document-space form,
invariant to a no-op write, was blind to.

## 8. jam.3 final write-discipline contract — ZW / EDGE-START / CAP / P

The completion commit (on top of the settle-window milestone) freezes the
fork's write discipline. The mechanics below are established behavior of the
pinned tip, certified by the deterministic probes listed. What is NOT
established: the attribution of the owner's specific observed symptoms to
these mechanisms — that is the leading hypothesis, pending the paired
native trace (tjam gate G5). Deterministic probes certify fork
write-discipline; native rubber-band survival under a real trackpad gesture
is certified only by the owner's native A/B — synthetic events don't.

- **ZW (zero-write windows).** While a user gesture owns the timeline —
  the gesture flag or the settle hold (no position/wheel signal has been
  silent for `SETTLE_STABILITY`) — the fork writes no scroll position at
  all on WebKit: corrections park, their visible consequence applied
  through the visible-offset range, and the whole backlog commits once at
  rest through the single flush path. End edges and mid-viewport idle
  flushes keep their writes exactly as pre-change; only the WHEN changes.
- **EDGE-START (geometry-only at the start edge).** Supersedes delta 3's
  scroll-compensated edge release. The guard keys on the CURRENT physical
  offset, not the corrected target: the re-sync may be written only when
  `relative + jump > 0` — strictly inside the content. At or past the
  start edge (current <= 0, elastic negatives included) the correction
  applies geometry only — offsets and total size update, the scroll
  position is never written, in gesture and idle states alike — AND the
  parked debt is CLEARED (`pendingJump = 0`). The invariant is LIVE: the
  clear rides the READER's own `ACTION_SCROLL` onto the edge — a
  geometry-only invalidation, no write, no release of the gesture/settle
  holds — and the settle/burst-quiescence flush path keeps the same clear
  as the BACKSTOP for positions that never transit a scroll event at the
  edge (programmatic sets, burst-only waves, idle-at-edge). The debt's
  duty is one-shot anchor preservation at the layout change; the free
  scroll to the edge voids it, and it rides EVERY item offset
  (`getItemOffset = getOffset - pendingJump`), so retaining it even
  briefly — settle-lagged — displaces the whole list: a blank band or
  clipped first rows with no write at all, through the pre-settle
  interval. If the anchor re-enters the range, the next measurement
  re-derives the correction. Keying on the target (`relative + jump +
pendingJump`) instead let a parked +Δ write +Δ from the edge — clipping
  the first row — and wrote at native −25 through the elastic stretch;
  the current-keyed form is the contract. The fork cannot push the
  scroller into or deeper into the elastic region at the top; that nudge
  is the mechanism the top band is expected to have come from
  (hypothesis, G5). The false ceiling delta 3 existed to lift is lifted
  by the inside-content re-anchor — the same retained write, never a
  stretch or edge write. The end edge keeps the delta-2-era absolute end
  clamp unchanged.
- **CAP (escape at rest).** Delta 2's one-viewport guard remains an
  ESCAPE threshold, not a per-write limit — when the parked backlog
  exceeds one viewport it commits ENTIRE, in one write, backlog cleared.
  The completion adds only the WHEN: mid-gesture the escape defers (the
  backlog parks whole and lands full-magnitude in the rest write — one
  larger re-anchor at rest, a stated trade); idle, burst (delta 7) and
  programmatic escapes fire as before, byte-for-byte. The during-gesture
  escape that delta 2's shipped guard exercised is filed as deliberate
  supersession; the guard now pins the idle and burst forms.
- **P (gesture-ON preemption).** At the observer's gesture-ON seam (the
  wheel/touch reports that set `gestureSeen`), a pending scroll-end epoch
  is cancelled and its deadline re-armed: the new gesture owns the
  timeline; the old timer cannot fire a commit mid-gesture. Motivating red
  (reviewer probe): a tail with the epoch armed and a fresh wheel-ON ~10 ms
  before the fire time, no delivered scroll to cancel it — the commit
  landed mid-flick.
- **Epoch semantics (explicit non-item).** A correction merging inside an
  open window rides that window's single at-rest re-sync; its visible
  consequence is its own reflow at the merge — inherent to any
  silence-window design. Restarting the window on merge activity was
  adjudicated against: it would defer only the invisible re-sync and
  starve it on a continuously measuring list, while risking the write
  racing motion that the pre-fix flicker was.

Probes (`src/jam-corrections.browser.spec.tsx`, all three engines unless
noted; unit forms in `src/core/store.spec.ts`):

| Probe                                             | Pins                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| (p) fresh wheel-ON preempts the armed epoch       | no scroll-end, no commit at the old fire time; stream rests → one flush; top-edge flick variant: zero writes end to end |
| (e) gap past the plain debounce inside the window | hold survives; one merged commit, never two                                                                             |
| (h) corrections netting to zero inside an epoch   | rest flush finds nothing: zero writes                                                                                   |
| (i) parked backlog + start edge during the tail   | zero writes at the edge in BOTH states, geometry changed, position user-owned, first row unclipped                      |
| (i, parity) same backlog, rest INSIDE the content | one relative re-anchor, whole, anchor still — the retained write probed where it lives                                  |
| (ii-a/ii-b) elastic stretch pass-through          | no fork spacer/translation, no write; rows at true offset − native position, geometry == truth                          |
| (iv) absolute-end regression (unmodified)         | idle bottom-pinned growth above: exactly one anchored write, rows still — the retained behavior                         |
| (v) end edge during a gesture                     | WebKit parks and keeps the position; one end-clamped commit at rest; #942 engines unchanged                             |
| reviewer backlog probe (±60 carried to native 0)  | never written at the edge, both states, both signs; rows at true offsets — unit forms: edge-park + elastic guards       |
| reviewer elastic probe (−25 → 0 with backlog)     | zero writes at every native position; spring-back keeps position and geometry truthful                                  |

Supersession filings in the completion commit's test diff: delta 3's
scroll-level edge-release guards → start-edge geometry-only forms (delta 2
and 3 sections above carry the banners); the delta-2 cap guard's
during-gesture escape → idle/burst forms; the delta-6 frozen-range guard's
release point → the burst's quiescence (delta 7 owns that release).

The completion commit also withdraws one condition its predecessor shipped
with: the static-backlog (revision-restart) third gate term was removed
after tracing the parking machinery — parked corrections are already
visually applied, and the flush is an invisible re-sync, so a late
correction parks invisibly and re-syncs on the next scroll without a second
visible write. The milestone commit's message documents the term as shipped
there; §8 is the contract of record.

One release-rule change rides with EDGE-START: scroll-end flushes the
backlog at idle direction too (probe (v)'s shape — a gesture that releases
without a delivered position must still commit what it parked; pre-ZW a
backlog could only exist inside a moving session, which is why upstream's
direction gate was safe there and is not here). A live burst remains the
sole deferral (R1).

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
  `-jam.<n>` tag, never replaced in place. Tags may be lightweight or
  annotated (`v0.53.3-jam.1` is lightweight, `v0.53.3-jam.2` annotated), so
  consumers verify `fork_commit` against the PEELed tag (`gh api
repos/thenvoi/virtua/git/tags/<obj-sha>` for annotated refs), never the raw
  `refs/tags` object.
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
