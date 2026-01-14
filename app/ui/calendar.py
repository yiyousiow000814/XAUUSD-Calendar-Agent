import json
from datetime import datetime, timezone
from pathlib import Path

from agent.config import parse_iso_time, to_display_time
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
            last_sync = parse_iso_time(self.state.get("last_sync_at", ""))
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
        if self.calendar_timer_id is not None:
            try:
                self.root.after_cancel(self.calendar_timer_id)
            except Exception:
                pass
        self._update_calendar_view(self.calendar_events)
        self.calendar_timer_id = self.root.after(60000, self._schedule_calendar_tick)

    def _load_calendar_events(self, repo_path: Path) -> list[dict]:
        now_utc = datetime.now(timezone.utc)
        calendar_root = repo_path / "data" / "Economic_Calendar"
        if not calendar_root.exists():
            return []
        year_dirs = []
        for entry in calendar_root.iterdir():
            if entry.is_dir() and entry.name.isdigit():
                year_dirs.append(int(entry.name))
        if not year_dirs:
            return []
        years = sorted(set(year_dirs))
        current_year = datetime.now().year
        candidates = [y for y in years if y in (current_year, current_year + 1)]
        if not candidates:
            candidates = [years[-1]]
        items: list[dict] = []
        for year in candidates:
            year_path = calendar_root / str(year)
            file_path = year_path / f"{year}_calendar.json"
            if not file_path.exists():
                matches = list(year_path.glob("*.json"))
                if not matches:
                    continue
                file_path = matches[0]
            try:
                payload = json.loads(file_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(payload, list):
                continue
            items.extend(payload)
        events = []
        for item in items:
            date_raw = item.get("Date")
            time_raw = (item.get("Time") or "").strip()
            event_raw = (item.get("Event") or "").strip()
            currency_raw = (item.get("Cur.") or "").strip()
            importance_raw = (item.get("Imp.") or "").strip()
            if not date_raw or not event_raw:
                continue
            try:
                date_val = datetime.strptime(date_raw, "%Y-%m-%d").date()
            except ValueError:
                continue
            time_label = time_raw or "All Day"
            if ":" in time_raw:
                try:
                    time_val = datetime.strptime(time_raw, "%H:%M").time()
                except ValueError:
                    time_val = datetime.min.time()
            else:
                time_val = datetime.min.time()
            dt_source = datetime.combine(date_val, time_val).replace(
                tzinfo=utc_offset_minutes_to_tzinfo(CALENDAR_SOURCE_UTC_OFFSET_MINUTES)
            )
            dt_utc = dt_source.astimezone(timezone.utc)
            if dt_utc < now_utc:
                continue
            events.append(
                {
                    "dt_utc": dt_utc,
                    "time_label": time_label,
                    "event": event_raw,
                    "currency": currency_raw.upper(),
                    "importance": importance_raw,
                }
            )
        events.sort(key=lambda item: item["dt_utc"])
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
