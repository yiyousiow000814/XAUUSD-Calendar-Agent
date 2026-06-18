# UI Testing

This project uses Playwright-based UI self-checks that auto-discover components tagged with
`data-qa` or `data-testid` tokens. Tags must follow the `qa:` prefix convention. See
`app/tests-ui/docs/QA_TAGGING.md` for the tagging rules.

## Quick start

1) Install dependencies:

```
npm --prefix app/webui install
npm --prefix app/tests-ui install
```

2) Run the UI regression suite (starts preview server by default):

```
npm run ui:test
```

3) First run will generate `app/tests-ui/artifacts/current`. Promote to baseline:

```
npm run ui:update-baseline
```

4) Open Playwright report:

```
npm run ui:report
```

## UI check & watch

`ui-check` runs the full interactive scenario suite for dark/light themes by default. Use the
focused commands first while iterating; save the full run for release or broad UI changes.
Outputs go to `app/tests-ui/artifacts/ui-check/`.

Fast Market Agent smoke:

```
npm run ui:check:fast
```

Fast smoke against an already-built `dist/`:

```
npm run ui:check:fast:nobuild
```

Fast smoke against a running Vite dev server on `127.0.0.1:5173`:

```
npm run ui:check:fast:dev
```

Focused Market Agent page checks:

```
npm run ui:check:market-agent
```

Full visual check:

```
npm run ui:check
```

Optional: control the theme-parallel worker count (defaults to 2 or theme count):

```
set UI_CHECK_WORKERS=2
npm run ui:check
```

Optional: cap animation-heavy checks concurrency (defaults to 2):

```
set UI_CHECK_ANIM_WORKERS=2
npm run ui:check
```

Optional: run each theme in an isolated process (separate servers, merged report):

```
set UI_CHECK_ISOLATED=1
set UI_CHECK_WORKERS=4
set UI_CHECK_PORT_BASE=4183
npm run ui:check
```

Focused `--filter` runs default to a shared single-process runner so iteration stays fast.
Enable `UI_CHECK_ISOLATED=1` when debugging theme process isolation. Disable isolation for a
full unfiltered run with:

```
set UI_CHECK_ISOLATED=0
npm run ui:check
```

`ui-watch` watches front-end changes and re-runs `ui-check` automatically.
It defaults to the fast Market Agent dashboard smoke path so local edits do not trigger a
full visual regression on every save.

```
npm run ui:watch
```

Use a wider watch mode only when the change touches broader surfaces:

```
set UI_WATCH_MODE=market-agent
npm run ui:watch
```

Run the full regression from watch mode only for release-level changes:

```
set UI_WATCH_MODE=full
npm run ui:watch
```

Each `ui-check` run prints per-check timings, a `UI-CHECK SLOWEST` list, skipped-by-filter
counts, and total runtime. To hide per-check timing noise:

```
set UI_CHECK_PROFILE=0
npm run ui:check:fast
```

## Mandatory visual review checklist (per UI change)

After every UI change, run `npm run ui:check` and review the evidence in
`app/tests-ui/artifacts/ui-check/report.html` plus videos (or multi-frame sampling if video review is
not possible). These items are mandatory:

1) Icon semantics (Settings = gear; Theme icon matches light/dark/system).
2) Modal transition (no hard-cut/flash on enter/exit).
3) Modal scroll ownership (wheel scroll stays inside modal; background stays locked).
4) Alignment (button columns, key separators, header/body grid alignment).
5) Spacing rhythm (section spacing consistent, label-to-value gap >= threshold).
6) Light/Dark/System readability (contrast and legibility consistent).
7) Hover shadow clipping (no box-shadow cut-off at edges).
8) Small viewport (modal still usable, internal scroll available, close visible).

### Subjective review gate (required)

Every UI change must include a written subjective review summary based on the generated
evidence. Without this, the change is not considered complete.

Format (fixed):
- Pass/Fail.
- 3-5 most obvious issues (if any).
- Specific fix actions planned.

Notes:
- Assertions are only the baseline. Final acceptance requires this subjective review.
- If video playback is not possible, use the multi-frame samples + numeric logs from
  `ui-check` to judge transitions (no hard cuts/flashes).

## Server modes

- Default (preview): uses `npm --prefix app/webui run build` + `npm --prefix app/webui run preview`.
- Dev server:

```
set UI_SERVER=dev
npm run ui:test
```

- Use an existing server:

```
set UI_BASE_URL=http://127.0.0.1:5173
npm run ui:test
```

## Artifacts

- `app/tests-ui/artifacts/baseline` - approved baseline screenshots
- `app/tests-ui/artifacts/current`  - current run screenshots
- `app/tests-ui/artifacts/diff`     - diffs when mismatch occurs
- `app/tests-ui/playwright-report`  - HTML report
- `app/tests-ui/artifacts/ui-check` - interactive check snapshots/video/report

## What the suite checks

- Discovery: auto-captures cards, modals, menus, toolbars, and overlays tagged with `qa:`.
- Theme contract: dark/light/system contrast checks.
- Loading contract: async action buttons must enter loading and return to idle.
- Animation contract: spinners/transitions must actually animate.
- Layout stability: state changes should not cause layout shift.
- Modal usability: close is visible, only one close, internal scroll enabled.
- Error visibility: initialization errors must show an overlay (no silent blank page).
