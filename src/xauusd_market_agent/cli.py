from __future__ import annotations

import argparse
from datetime import datetime
import json
import sys

from .config import MarketAgentConfig
from .fixtures import list_builtin_scenarios, load_builtin_fixture
from .history import load_alert_history
from .live_pipeline import (
    build_live_evidence_packet,
    run_live_once,
    run_monitor_loop,
    run_monitored_live_once,
)
from .providers.related_assets import refresh_related_assets_cache
from .pipeline import build_rule_based_analysis
from .reporter import render_text_report
from .self_audit import audit_market_agent, read_current_status, read_provider_health_status
from .timeline_store import TimelineStore


def run_dry_scenario(scenario_id: str):
    fixture = load_builtin_fixture(scenario_id)
    return build_rule_based_analysis(fixture)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Run the XAUUSD market situation agent.")
    parser.add_argument("--dry-run", action="store_true", help="Run one built-in fixture scenario.")
    parser.add_argument("--live-once", action="store_true", help="Run one live analysis pass using local data providers.")
    parser.add_argument("--monitor-once", action="store_true", help="Run one live analysis pass with persisted state and local alert output.")
    parser.add_argument("--monitor-loop", action="store_true", help="Run repeated monitored live passes in a local loop.")
    parser.add_argument("--backfill-recovery", action="store_true", help="Run one monitored pass and recover missed data when an offline gap is detected.")
    parser.add_argument("--timeline", action="store_true", help="Query persisted timeline events.")
    parser.add_argument("--replay", action="store_true", help="Query replay data from the timeline store.")
    parser.add_argument("--export-timeline", action="store_true", help="Export persisted replay data.")
    parser.add_argument("--self-check", action="store_true", help="Audit Market Agent storage, inputs, AI, and replay health.")
    parser.add_argument("--status", action="store_true", help="Print current Market Agent monitor, evidence, AI, and storage status.")
    parser.add_argument("--provider-health", action="store_true", help="Print latest Market Agent provider health rows.")
    parser.add_argument("--scenario", default="yield_pressure_confirmed", help="Fixture scenario id.")
    parser.add_argument("--format", choices=("text", "json"), default="text", help="Output format.")
    parser.add_argument("--list-scenarios", action="store_true", help="List built-in dry-run scenarios.")
    parser.add_argument("--alert-history", action="store_true", help="Print local alert history.")
    parser.add_argument("--refresh-related-assets", action="store_true", help="Refresh related-asset CSV cache from configured source mapping.")
    parser.add_argument("--anchor-time", help="Optional anchor time in ISO 8601 format for live mode.")
    parser.add_argument("--interval-seconds", type=int, default=60, help="Loop interval for monitor-loop mode.")
    parser.add_argument("--max-iterations", type=int, help="Optional loop cap for monitor-loop mode.")
    parser.add_argument("--start", help="Start timestamp in ISO 8601 format.")
    parser.add_argument("--end", help="End timestamp in ISO 8601 format.")
    args = parser.parse_args()

    if args.list_scenarios:
        for scenario in list_builtin_scenarios():
            print(scenario)
        return
    if args.alert_history:
        cfg = MarketAgentConfig()
        print(
            json.dumps(
                load_alert_history(cfg.alerts_output_path, cfg.timeline_store_path),
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    if args.refresh_related_assets:
        cfg = MarketAgentConfig()
        if cfg.related_assets_sources_path is None or cfg.related_assets_dir is None:
            parser.error("Set MARKET_AGENT_RELATED_ASSETS_SOURCES_PATH and MARKET_AGENT_RELATED_ASSETS_DIR first.")
        refreshed = refresh_related_assets_cache(cfg.related_assets_sources_path, cfg.related_assets_dir)
        print(json.dumps({"refreshed": refreshed}, ensure_ascii=False, indent=2))
        return
    if args.self_check:
        cfg = MarketAgentConfig()
        print(json.dumps(audit_market_agent(cfg), ensure_ascii=False, indent=2))
        return
    if args.status:
        cfg = MarketAgentConfig()
        print(json.dumps(read_current_status(cfg), ensure_ascii=False, indent=2))
        return
    if args.provider_health:
        cfg = MarketAgentConfig()
        print(json.dumps(read_provider_health_status(cfg), ensure_ascii=False, indent=2))
        return
    if args.timeline or args.replay or args.export_timeline:
        if not args.start or not args.end:
            parser.error("Pass --start and --end for timeline or replay queries.")
        cfg = MarketAgentConfig()
        store = TimelineStore(cfg.timeline_store_path)
        if args.timeline:
            payload = store.get_timeline(args.start, args.end)
        else:
            payload = store.get_market_replay(args.start, args.end)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    if args.live_once:
        cfg = MarketAgentConfig()
        anchor = datetime.fromisoformat(args.anchor_time) if args.anchor_time else None
        fixture, result = run_live_once(cfg, anchor_time=anchor)
        if args.format == "json":
            packet = build_live_evidence_packet(cfg, anchor_time=anchor or datetime.now().astimezone())
            print(
                json.dumps(
                    {
                        "evidence_packet": packet,
                        "analysis": result.to_dict(),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return
        print(render_text_report(fixture, result))
        return
    if args.monitor_once:
        cfg = MarketAgentConfig()
        anchor = datetime.fromisoformat(args.anchor_time) if args.anchor_time else None
        outcome = run_monitored_live_once(cfg, anchor_time=anchor)
        print(json.dumps(outcome, ensure_ascii=False, indent=2))
        return
    if args.backfill_recovery:
        cfg = MarketAgentConfig()
        anchor = datetime.fromisoformat(args.anchor_time) if args.anchor_time else None
        outcome = run_monitored_live_once(cfg, anchor_time=anchor)
        print(json.dumps({"recovery": outcome}, ensure_ascii=False, indent=2))
        return
    if args.monitor_loop:
        cfg = MarketAgentConfig()
        outcomes = run_monitor_loop(
            config=cfg,
            interval_seconds=args.interval_seconds,
            max_iterations=args.max_iterations,
            anchor_times=[datetime.fromisoformat(args.anchor_time)] if args.anchor_time else None,
        )
        print(json.dumps(outcomes, ensure_ascii=False, indent=2))
        return
    if not args.dry_run:
        parser.error("Pass --dry-run, --live-once, --monitor-once, --monitor-loop, or --backfill-recovery.")

    fixture = load_builtin_fixture(args.scenario)
    result = build_rule_based_analysis(fixture)
    if args.format == "json":
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
        return
    print(render_text_report(fixture, result))


if __name__ == "__main__":
    main()
