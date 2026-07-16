# Market Agent Activity Signal Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Activity page card stack with an interactive multi-lane signal map that shows sources, processing, AI checkpoints, storage, outputs, and trace details.

**Architecture:** Keep `MarketAgentPage` wiring unchanged and replace the internals of `MarketAgentActivity` with focused signal-map components and helpers. Build all map data from the existing props first, then add detail drawer and trace highlighting without requiring backend schema changes.

**Tech Stack:** React 18, TypeScript, CSS modules via component CSS, Vitest + Testing Library, existing Market Agent UI utilities.

---

### Task 1: Activity Signal Map Test Coverage

**Files:**
- Modify: `app/webui/src/__tests__/market-agent-page.test.tsx`

- [ ] **Step 1: Add failing tests for the redesigned Activity page**

Add tests that open the Activity section and assert:

```tsx
expect(within(agentActivity).getByText(/Signal Map/i)).toBeInTheDocument();
expect(within(agentActivity).getByText(/Market Sensors/i)).toBeInTheDocument();
expect(within(agentActivity).getByText(/Storage Bus/i)).toBeInTheDocument();
expect(within(agentActivity).getByText(/Raw collected/i)).toBeInTheDocument();
expect(within(agentActivity).getByText(/Processed \/ derived/i)).toBeInTheDocument();
expect(within(agentActivity).getByText(/DXY/i)).toBeInTheDocument();
expect(within(agentActivity).getByText(/US10Y/i)).toBeInTheDocument();
expect(within(agentActivity).getByText(/Candidate Sensors/i)).toBeInTheDocument();
expect(within(agentActivity).getByText(/Discovered Sensors/i)).toBeInTheDocument();
```

Add an interaction assertion:

```tsx
fireEvent.click(within(agentActivity).getByRole("button", { name: /DXY/i }));
expect(within(agentActivity).getByRole("dialog", { name: /DXY/i })).toBeInTheDocument();
expect(within(agentActivity).getByText(/Where it comes from/i)).toBeInTheDocument();
expect(within(agentActivity).getByText(/What is happening now/i)).toBeInTheDocument();
expect(within(agentActivity).getByText(/Storage/i)).toBeInTheDocument();
expect(within(agentActivity).getByText(/related_asset_bars/i)).toBeInTheDocument();
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --prefix app\webui run test -- --run src/__tests__/market-agent-page.test.tsx
```

Expected: failure because the signal map labels and dialog are not implemented yet.

### Task 2: Signal Map Component Model

**Files:**
- Create: `app/webui/src/components/market-agent-activity/signalMapModel.ts`
- Modify: `app/webui/src/components/MarketAgentActivity.tsx`

- [ ] **Step 1: Create model types and builders**

Create `SignalNode`, `SignalLane`, `SignalTrace`, and builder helpers that derive:

- source lanes: price, history, news, calendar, market sensors
- processing nodes: move detection, replay rows, grouping, context, confirmation, evidence gate, driver attention, evidence packet
- AI nodes: display summarizer, cause review, validator/repair, replay condenser, alert review
- storage nodes: raw collected, processed/derived
- output nodes: dashboard, evidence, replay, telegram

The model must include detail fields:

```ts
type SignalNode = {
  id: string;
  label: string;
  lane: string;
  status: string;
  action: string;
  source: string;
  processing: string;
  output: string;
  storage: string[];
  ai: string;
  trace: string[];
};
```

- [ ] **Step 2: Wire model into Activity component**

Replace the old section/node arrays with a call to the model builder. Keep existing props and utility imports.

### Task 3: Signal Map Rendering

**Files:**
- Create: `app/webui/src/components/market-agent-activity/MarketAgentSignalMap.tsx`
- Create: `app/webui/src/components/market-agent-activity/SignalDetailDrawer.tsx`
- Create: `app/webui/src/components/market-agent-activity/StorageBus.tsx`
- Modify: `app/webui/src/components/MarketAgentActivity.tsx`

- [ ] **Step 1: Render multi-lane signal map**

Implement compact lane sections with buttons for nodes. Each node button shows label, status, action, and output target.

- [ ] **Step 2: Render Market Sensors as core/candidate/discovered groups**

Core sensors must show DXY, US10Y, US2Y, WTI, Brent, VIX, S&P 500, Nasdaq. Candidate/discovered groups must show inferred or empty-state nodes without pretending unmapped data exists.

- [ ] **Step 3: Render detail drawer**

Selecting a node opens an in-page drawer/dialog with sections:

- What this is
- Where it comes from
- What is happening now
- Inputs
- Processing
- AI involvement
- Outputs
- Storage
- Trace

### Task 4: Signal Map Styling

**Files:**
- Modify: `app/webui/src/components/MarketAgentActivity.css`

- [ ] **Step 1: Replace card-stack styles with circuit-board styles**

Use thin traces, compact node buttons, status lights, lane labels, and a bottom Storage Bus. Keep the UI dense but readable in dark and light themes.

- [ ] **Step 2: Add responsive layout**

At smaller widths, stack lanes vertically and keep the detail drawer below the selected node area. Text must not overflow node buttons.

### Task 5: Verification

**Files:**
- Test: `app/webui/src/__tests__/market-agent-page.test.tsx`

- [ ] **Step 1: Run focused test**

Run:

```powershell
npm --prefix app\webui run test -- --run src/__tests__/market-agent-page.test.tsx
```

Expected: all MarketAgentPage tests pass.

- [ ] **Step 2: Run full frontend checks**

Run:

```powershell
npm --prefix app\webui run test
npm --prefix app\webui run build
```

Expected: all tests pass; build exits 0.

- [ ] **Step 3: Run UI check**

Run:

```powershell
$env:UI_BASE_URL='http://127.0.0.1:5173'; $env:UI_CHECK_VIDEO='0'; $env:UI_CHECK_WORKERS='1'; npm run ui:check
```

Expected: ui-check exits 0 and writes `app/tests-ui/artifacts/ui-check/report.html`.

- [ ] **Step 4: Review screenshots**

Randomly inspect 5 Light/Dark screenshots under `app/tests-ui/artifacts/ui-check/*/snapshots`. If any Activity page overlap or unreadable text is found, fix and rerun `npm run ui:check`.

