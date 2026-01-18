# UI Testing

This project uses Playwright-based UI self-checks that auto-discover components tagged with
`data-qa` or `data-testid` tokens. Tags must follow the `qa:` prefix convention. See
`app/ui-testing/docs/QA_TAGGING.md` for the tagging rules.

## Quick start

1) Install dependencies:

```
npm --prefix app/webui install
npm --prefix app/ui-testing install
```

2) Run the UI regression suite (starts preview server by default):

```
npm run ui:test
```

3) First run will generate `app/ui-testing/artifacts/current`. Promote to baseline:

```
npm run ui:update-baseline
```

4) Open Playwright report:

```
npm run ui:report
```

## UI check & watch

`ui-check` runs an interactive scenario suite for every theme (dark/light/system). Each
scenario is captured per-theme with side-by-side report rows, plus video frames for motion
verification. Outputs go to `app/ui-testing/artifacts/ui-check/`.

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

Disable isolation (runs all themes in a single process):

```
set UI_CHECK_ISOLATED=0
npm run ui:check
```

`ui-watch` watches front-end changes and re-runs `ui-check` automatically.

```
npm run ui:watch
```

## Mandatory visual review checklist (per UI change)

After every UI change, run `npm run ui:check` and review the evidence in
`app/ui-testing/artifacts/ui-check/report.html` plus videos (or multi-frame sampling if video review is
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

- `app/ui-testing/artifacts/baseline` - approved baseline screenshots
- `app/ui-testing/artifacts/current`  - current run screenshots
- `app/ui-testing/artifacts/diff`     - diffs when mismatch occurs
- `app/ui-testing/playwright-report`  - HTML report
- `app/ui-testing/artifacts/ui-check` - interactive check snapshots/video/report

## What the suite checks

- Discovery: auto-captures cards, modals, menus, toolbars, and overlays tagged with `qa:`.
- Theme contract: dark/light/system contrast checks.
- Loading contract: async action buttons must enter loading and return to idle.
- Animation contract: spinners/transitions must actually animate.
- Layout stability: state changes should not cause layout shift.
- Modal usability: close is visible, only one close, internal scroll enabled.
- Error visibility: initialization errors must show an overlay (no silent blank page).
