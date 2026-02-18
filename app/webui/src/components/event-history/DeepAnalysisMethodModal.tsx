import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import "./DeepAnalysisMethodModal.css";

type SignalChip = { id?: string; title?: string; note?: string; weight?: number } | string;

type DeepAnalysisMethodModalProps = {
  open: boolean;
  onClose: () => void;
  pointsCount: number;
  modelLabel: string;
  signalsUsed: SignalChip[] | null;
};

function MiniBars() {
  // A tiny diagram: three outcome bars (> / = / <).
  return (
    <svg className="deep-tut-svg" viewBox="0 0 240 80" role="img" aria-label="Outcome probabilities">
      <rect x="10" y="18" width="220" height="44" rx="10" className="deep-tut-surface" />
      <rect x="22" y="30" width="120" height="20" rx="7" className="deep-tut-bar gt" />
      <rect x="146" y="30" width="46" height="20" rx="7" className="deep-tut-bar eq" />
      <rect x="196" y="30" width="28" height="20" rx="7" className="deep-tut-bar lt" />
      <text x="26" y="16" className="deep-tut-svg-label">
        Predict Release
      </text>
      <text x="22" y="72" className="deep-tut-svg-mini">
        &gt; / = / &lt;
      </text>
    </svg>
  );
}

function MiniSurprise() {
  // A tiny diagram: Actual around Forecast (beat / close / miss).
  return (
    <svg className="deep-tut-svg" viewBox="0 0 240 80" role="img" aria-label="Actual vs Forecast surprise">
      <rect x="10" y="18" width="220" height="44" rx="10" className="deep-tut-surface" />
      <line x1="22" y1="56" x2="224" y2="56" className="deep-tut-axis" />
      <line x1="124" y1="26" x2="124" y2="60" className="deep-tut-tick" />
      <circle cx="90" cy="46" r="3.8" className="deep-tut-dot soft" />
      <circle cx="124" cy="40" r="3.8" className="deep-tut-dot" />
      <circle cx="160" cy="34" r="3.8" className="deep-tut-dot soft" />
      <text x="26" y="16" className="deep-tut-svg-label">
        Surprise vs Forecast
      </text>
      <text x="108" y="72" className="deep-tut-svg-mini">
        beat / close / miss
      </text>
    </svg>
  );
}

function MiniApproxEq() {
  // A tiny diagram: "approx equal" as a tolerance band around Forecast.
  return (
    <svg className="deep-tut-svg" viewBox="0 0 240 80" role="img" aria-label="Approx equal rule">
      <rect x="10" y="18" width="220" height="44" rx="10" className="deep-tut-surface" />
      <line x1="24" y1="56" x2="226" y2="56" className="deep-tut-axis" />
      <rect x="114" y="34" width="22" height="22" rx="11" className="deep-tut-eqband" />
      <line x1="125" y1="30" x2="125" y2="60" className="deep-tut-tick" />
      <circle cx="119" cy="44" r="3.6" className="deep-tut-dot soft" />
      <circle cx="131" cy="44" r="3.6" className="deep-tut-dot soft" />
      <circle cx="129" cy="44" r="3.9" className="deep-tut-dot" />
      <text x="26" y="16" className="deep-tut-svg-label">
        "=" means approx equal
      </text>
      <text x="104" y="72" className="deep-tut-svg-mini">
        within a small tolerance
      </text>
    </svg>
  );
}

function MiniPath() {
  // A tiny diagram: unified path with an anchor at 0.
  return (
    <svg className="deep-tut-svg" viewBox="0 0 240 80" role="img" aria-label="Unified outlook path">
      <rect x="10" y="18" width="220" height="44" rx="10" className="deep-tut-surface" />
      <line x1="22" y1="56" x2="224" y2="56" className="deep-tut-axis" />
      <line x1="124" y1="24" x2="124" y2="60" className="deep-tut-anchor" />
      <path d="M 22 50 L 60 46 L 92 48 L 124 40 L 154 44 L 184 38 L 224 42" className="deep-tut-line" />
      <circle cx="124" cy="40" r="3.8" className="deep-tut-dot" />
      <text x="26" y="16" className="deep-tut-svg-label">
        Unified Outlook P(t)
      </text>
      <text x="108" y="72" className="deep-tut-svg-mini">
        now
      </text>
    </svg>
  );
}

function MiniClick() {
  // A tiny diagram: clicking an event shows a dashed "without this event" line.
  return (
    <svg className="deep-tut-svg" viewBox="0 0 240 80" role="img" aria-label="Click to highlight contribution">
      <rect x="10" y="18" width="220" height="44" rx="10" className="deep-tut-surface" />
      <path d="M 22 50 L 60 46 L 92 48 L 124 40 L 154 44 L 184 38 L 224 42" className="deep-tut-line" />
      <path d="M 22 52 L 60 48 L 92 50 L 124 46 L 154 46 L 184 44 L 224 46" className="deep-tut-line dashed" />
      <circle cx="92" cy="48" r="3.8" className="deep-tut-dot soft" />
      <circle cx="124" cy="40" r="3.8" className="deep-tut-dot" />
      <text x="26" y="16" className="deep-tut-svg-label">
        Tap an event
      </text>
      <text x="22" y="72" className="deep-tut-svg-mini">
        solid = with, dashed = without
      </text>
    </svg>
  );
}

function MiniFlow() {
  // A tiny diagram: data sources -> signals -> outputs.
  return (
    <svg
      className="deep-tut-svg deep-tut-svg--flow"
      viewBox="0 0 520 140"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Where the numbers come from (flow)"
    >
      <rect x="10" y="10" width="500" height="120" rx="16" className="deep-tut-surface" />

      {/* Slightly taller so the subtitle doesn't kiss the bottom edge. */}
      <rect x="26" y="30" width="158" height="44" rx="12" className="deep-tut-flow-box" />
      <text x="38" y="54" className="deep-tut-flow-t">
        Release history
      </text>
      <text x="38" y="70" className="deep-tut-flow-s">
        Actual / Forecast / Previous
      </text>

      <rect x="26" y="84" width="158" height="32" rx="12" className="deep-tut-flow-box soft" />
      <text x="38" y="105" className="deep-tut-flow-t">
        Deep signals
      </text>

      <path d="M 194 52 L 238 52" className="deep-tut-flow-arrow" />
      <path d="M 194 100 L 238 100" className="deep-tut-flow-arrow" />
      <path d="M 238 52 L 232 48 L 232 56 Z" className="deep-tut-flow-arrowhead" />
      <path d="M 238 100 L 232 96 L 232 104 Z" className="deep-tut-flow-arrowhead" />

      <rect x="250" y="28" width="244" height="44" rx="12" className="deep-tut-flow-out" />
      <text x="264" y="52" className="deep-tut-flow-t">
        Predict Release
      </text>
      <text x="264" y="68" className="deep-tut-flow-s">
        recent 1-6 months + approx "="
      </text>

      <rect x="250" y="80" width="244" height="44" rx="12" className="deep-tut-flow-out" />
      <text x="264" y="104" className="deep-tut-flow-t">
        Unified Outlook P(t)
      </text>
      <text x="264" y="120" className="deep-tut-flow-s">
        one main path + contributions
      </text>

      <text x="26" y="24" className="deep-tut-svg-label">
        Where the numbers come from
      </text>
    </svg>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="deep-tut-step">
      <div className="deep-tut-step-n" aria-hidden="true">
        {n}
      </div>
      <div className="deep-tut-step-main">
        <div className="deep-tut-step-title">{title}</div>
        <div className="deep-tut-step-body">{children}</div>
      </div>
    </div>
  );
}

export function DeepAnalysisMethodModal({
  open,
  onClose,
  pointsCount,
  modelLabel,
  signalsUsed
}: DeepAnalysisMethodModalProps) {
  if (!open) return null;
  if (typeof document === "undefined") return null;

  const used = Array.isArray(signalsUsed) ? signalsUsed : [];

  return createPortal(
    <div
      className="modal-backdrop modal-backdrop-deep-method open"
      data-qa="qa:modal-backdrop:deep-method"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-deep-method open"
        data-qa="qa:modal:deep-method"
        role="dialog"
        aria-modal="true"
        aria-label="How deep analysis is computed"
      >
        <div className="deep-method-header">
          <div className="deep-method-title">How deep analysis works</div>
          <button type="button" className="deep-method-close" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="deep-method-body deep-tut">
          <div className="deep-tut-lead">
            Deep Analysis is a "best guess + why" page. It is designed to be quick to scan, and easy to sanity-check.
          </div>

          <Step n="1" title="What you see (with small examples)">
            <div className="deep-tut-cards">
              <div className="deep-tut-card">
                <MiniBars />
                <div className="deep-tut-card-text">
                  <div className="deep-tut-card-h">Predict Release</div>
                  <div className="deep-tut-card-p">
                    We estimate the chance that the next release will be above / approx equal / below the{" "}
                    <b>Previous</b>. When Forecast exists, we also show the same breakdown vs <b>Forecast</b>{" "}
                    (beat/miss expectations).
                  </div>
                  <div className="deep-tut-example">
                    Read it like this: <b>&gt; 88%</b> means <b>P(Actual &gt; Previous) ≈ 88%</b>.
                  </div>
                  <div className="deep-tut-example">
                    Expectation example: <b>&lt; 66%</b> means <b>P(Actual &lt; Forecast) ≈ 66%</b>.
                  </div>
                  <div className="deep-tut-example">
                    How we form the guess:
                    <span className="deep-tut-inline">
                      (1) a small calendar model turns recent history (+ Forecast/Previous when available) into{" "}
                      probabilities &rarr; (2) we compute a confidence score &rarr; (3) when available, we may also use
                      a relationship-based “nowcast chain” (recent correlated releases) to cross-check or replace
                      low-confidence outputs.
                    </span>
                  </div>
                  <div className="deep-tut-example">
                    Sanity check: we show <b>N</b> (history size), a confidence score, and a backtest reliability hint.
                    If confidence is low, treat the top line as a rough guess.
                  </div>
                  <div className="deep-tut-example">
                    High-impact releases use a stricter confidence threshold before we label the result as “reliable”.
                  </div>
                </div>
              </div>
              <div className="deep-tut-card">
                <MiniSurprise />
                <div className="deep-tut-card-text">
                  <div className="deep-tut-card-h">Why Forecast matters</div>
                  <div className="deep-tut-card-p">
                    Many short-term reactions are driven by <b>surprise</b>: Actual vs what the market expected
                    (Forecast). That is why we show both comparisons.
                  </div>
                  <div className="deep-tut-example">
                    If our A-P and A-F signals disagree, it usually means higher “surprise risk” (treat with extra
                    caution).
                  </div>
                </div>
              </div>
              <div className="deep-tut-card">
                <MiniPath />
                <div className="deep-tut-card-text">
                  <div className="deep-tut-card-h">Unified Outlook P(t) + Decision Card</div>
                  <div className="deep-tut-card-p">
                    One single line that summarizes the market bias around the selected event time (t=0).
                  </div>
                  <div className="deep-tut-example">Example: You always see one main path, not one path per event.</div>
                  <div className="deep-tut-example">
                    Quick read: we only surface horizons with a meaningful edge (e.g. 10pp+ away from 50%). If none
                    qualify, we show “No clear edge”. Edge means |P(up) - 50%|; very small edges are usually noise.
                  </div>
                  <div className="deep-tut-example">
                    Decision Card only enables a trade bias when guardrails pass together: sample size, recent share,
                    model coverage, backtest accuracy, and calibration gap.
                  </div>
                </div>
              </div>
              <div className="deep-tut-card">
                <MiniApproxEq />
                <div className="deep-tut-card-text">
                  <div className="deep-tut-card-h">Approx equal ("=")</div>
                  <div className="deep-tut-card-p">
                    "=" is approximate, not strict. Small differences are treated as "close enough".
                  </div>
                  <div className="deep-tut-example">
                    Example: if the typical month-to-month change is tiny, we treat tiny noise as "=".
                  </div>
                </div>
              </div>
            </div>
          </Step>

          <Step n="2" title="Tap an event to see its effect (without changing the main story)">
            <div className="deep-tut-wide">
              <MiniClick />
              <div className="deep-tut-wide-text">
                Tapping an event highlights its contribution. When available, we also draw a dashed “without this event”
                line, so you can compare quickly.
              </div>
            </div>
          </Step>

          <Step n="3" title="Where the numbers come from">
            <div className="deep-tut-flow">
              <MiniFlow />
              <div className="deep-tut-flow-notes">
                <div className="deep-tut-li">
                  <span className="deep-tut-dot2" aria-hidden="true" /> Predict Release is computed from release
                  history (no price data required).
                </div>
                <div className="deep-tut-li">
                  <span className="deep-tut-dot2" aria-hidden="true" /> If deep JSON is missing, we fall back to a
                  schedule-window estimate (less detailed).
                </div>
                <div className="deep-tut-li">
                  <span className="deep-tut-dot2" aria-hidden="true" /> Trade bias is disabled by design when
                  confidence gates fail (to avoid forced low-quality calls).
                </div>
              </div>
            </div>
          </Step>

          <div className="deep-tut-split">
            <div className="deep-tut-box">
              <div className="deep-tut-box-h">Credibility (quick check)</div>
              <div className="deep-method-kv">
                <span className="deep-method-k">History N</span>
                <span className="deep-method-v">{pointsCount}</span>
              </div>
              <div className="deep-method-kv">
                <span className="deep-method-k">Model</span>
                <span className="deep-method-v">{modelLabel}</span>
              </div>
              <div className="deep-tut-mini">
                Bigger N usually helps, but regime shifts can still break historical patterns.
              </div>
            </div>

            <div className="deep-tut-box">
              <div className="deep-tut-box-h">Signals used (if any)</div>
              {used.length ? (
                <div className="deep-method-signals">
                  {used.slice(0, 24).map((s: any, idx: number) => (
                    <span key={String(s?.id ?? idx)} className="deep-signal-chip">
                      {String(s?.title ?? s?.id ?? s)}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="deep-tut-mini">This view is currently running with minimal signals.</div>
              )}
            </div>
          </div>

          <div className="deep-tut-foot">
            <div className="deep-tut-foot-h">Limitations (read in 5 seconds)</div>
            <div className="deep-tut-badges">
              <div className="deep-tut-badge">
                <span className="deep-tut-badge-ic" aria-hidden="true" />
                <div>
                  <div className="deep-tut-badge-t">Regime shifts</div>
                  <div className="deep-tut-badge-s">Relationships can break.</div>
                </div>
              </div>
              <div className="deep-tut-badge">
                <span className="deep-tut-badge-ic" aria-hidden="true" />
                <div>
                  <div className="deep-tut-badge-t">Correlation</div>
                  <div className="deep-tut-badge-s">Attribution is approximate.</div>
                </div>
              </div>
              <div className="deep-tut-badge">
                <span className="deep-tut-badge-ic" aria-hidden="true" />
                <div>
                  <div className="deep-tut-badge-t">Data issues</div>
                  <div className="deep-tut-badge-s">Missing values & revisions affect stats.</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
