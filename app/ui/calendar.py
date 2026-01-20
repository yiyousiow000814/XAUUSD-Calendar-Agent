from datetime import datetime, timezone
from pathlib import Path

from agent.calendar_loader import load_calendar_events
from agent.config import (
    get_selected_output_dir_last_sync_at,
    parse_iso_time,
    to_display_time,
)
from agent.timezone import (
    CALENDAR_SOURCE_UTC_OFFSET_MINUTES,
    clamp_utc_offset_minutes,
    get_system_utc_offset_minutes,
    utc_offset_minutes_to_tzinfo,
)


class CalendarMixin:

    def _effective_calendar_utc_offset_minutes(self) -> int:
        mode = (self.state.get("calendar_timezone_mode") or "system").strip().lower()
        if mode == "system":
            return clamp_utc_offset_minutes(get_system_utc_offset_minutes())
        return clamp_utc_offset_minutes(
            int(self.state.get("calendar_utc_offset_minutes", 0))
        )

    def _refresh_times(self) -> None:
        def _update() -> None:
            last_pull = parse_iso_time(self.state.get("last_pull_at", ""))
            last_sync = parse_iso_time(get_selected_output_dir_last_sync_at(self.state))
            self.last_pull_var.set(to_display_time(last_pull))
            self.last_sync_var.set(to_display_time(last_sync))

        self.root.after(0, _update)

    def _refresh_calendar_data(self) -> None:
        repo_path = self._resolve_repo_path()
        if not repo_path:
            self._update_calendar_view([])
            return
        events = self._load_calendar_events(repo_path)
        self.calendar_events = events
        self._update_currency_options(events)
        self._update_calendar_view(events)

    def _schedule_calendar_tick(self) -> None:
        interval_seconds = int(self.state.get("ui_calendar_tick_seconds", 60) or 60)
        self._calendar_tick()
        self.scheduler.schedule_interval(
            "calendar_tick", max(1, interval_seconds) * 1000, self._calendar_tick
        )

    def _calendar_tick(self) -> None:
        self._update_calendar_view(self.calendar_events)

    def _load_calendar_events(self, repo_path: Path) -> list[dict]:
        items = load_calendar_events(str(repo_path))
        events = self._filter_upcoming_events(items)
        events.sort(key=lambda item: item["dt_utc"])
        return events

    def _filter_upcoming_events(self, items: list[dict]) -> list[dict]:
        now_utc = datetime.now(timezone.utc)
        events = []
        for item in items:
            dt_utc = item.get("dt_utc")
            if not isinstance(dt_utc, datetime):
                continue
            if dt_utc < now_utc:
                continue
            events.append(item)
        return events

    def _update_currency_options(self, events: list[dict]) -> None:
        if not hasattr(self, "currency_combo"):
            return
        currencies = {
            event.get("currency", "") for event in events if event.get("currency")
        }
        options = ["USD"]
        options.extend(sorted(currency for currency in currencies if currency != "USD"))
        options.append("ALL")
        self.currency_combo["values"] = options
        if self.currency_var.get() not in options:
            self.currency_var.set("USD" if "USD" in options else "ALL")

    def _format_countdown(self, target_utc: datetime) -> str:
        delta = target_utc - datetime.now(timezone.utc)
        if delta.total_seconds() <= 0:
            return "Now"
        minutes = int(delta.total_seconds() // 60)
        hours, mins = divmod(minutes, 60)
        days, hours = divmod(hours, 24)
        if days > 0:
            return f"{days}d {hours}h"
        return f"{hours}h {mins}m"

    def _update_calendar_view(self, events: list[dict]) -> None:
        def _render() -> None:
            if not hasattr(self, "calendar_list"):
                return
            selected = self.currency_var.get().strip().upper()
            tz = utc_offset_minutes_to_tzinfo(
                self._effective_calendar_utc_offset_minutes()
            )
            source_tz = utc_offset_minutes_to_tzinfo(CALENDAR_SOURCE_UTC_OFFSET_MINUTES)
            for item in self.calendar_list.get_children():
                self.calendar_list.delete(item)
            if not events:
                self.calendar_list.insert(
                    "",
                    "end",
                    values=("--", "--", "--", "No upcoming events", "--"),
                )
                return
            shown = 0
            for event in events:
                currency = event.get("currency", "").upper()
                if selected != "ALL" and currency != selected:
                    continue
                dt_utc = event["dt_utc"]
                time_label = event["time_label"]
                event_name = event["event"]
                importance = event.get("importance", "")
                dt_display = dt_utc.astimezone(tz)
                time_text = dt_display.strftime("%d-%m-%Y %H:%M")
                label = time_label.strip()
                source_date = dt_utc.astimezone(source_tz).strftime("%d-%m-%Y")
                if label.lower() == "all day":
                    time_text = f"{source_date} All Day"
                elif label and ":" not in label:
                    time_text = f"{dt_display.strftime('%d-%m-%Y')} {label}"
                countdown = self._format_countdown(dt_utc)
                tag = None
                if importance:
                    imp_key = importance.lower()
                    if "high" in imp_key:
                        tag = "imp_high"
                    elif "medium" in imp_key:
                        tag = "imp_medium"
                    elif "low" in imp_key:
                        tag = "imp_low"
                    elif "holiday" in imp_key:
                        tag = "imp_holiday"
                self.calendar_list.insert(
                    "",
                    "end",
                    values=(
                        time_text,
                        currency or "--",
                        importance or "--",
                        event_name,
                        countdown,
                    ),
                    tags=(tag,) if tag else (),
                )
                shown += 1
                if shown >= 12:
                    break

        self.root.after(0, _render)

    def _on_currency_changed(self, *_args) -> None:
        self._update_calendar_view(self.calendar_events)
