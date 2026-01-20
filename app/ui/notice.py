from datetime import datetime


class NoticeMixin:

    def _append_notice(self, message: str, level: str = "AUTO") -> None:
        def _insert() -> None:
            timestamp = datetime.now().strftime("%d-%m-%Y %H:%M")
            normalized = message.lower()
            resolved = level.upper()
            if resolved == "AUTO":
                if "error" in normalized:
                    resolved = "ERROR"
                elif "fail" in normalized or "missing" in normalized:
                    resolved = "WARN"
                else:
                    resolved = "INFO"
            entry = {"time": timestamp, "message": message, "level": resolved}
            self.notice_entries.insert(0, entry)
            if len(self.notice_entries) > 200:
                self.notice_entries = self.notice_entries[:200]
            self._refresh_notice_view()

        scheduler = getattr(self, "scheduler", None)
        if scheduler:
            scheduler.call_soon(_insert)
        else:
            self.root.after(0, _insert)

    def _refresh_notice_view(self) -> None:
        self.notice_list.delete(*self.notice_list.get_children())
        selected = self.log_filter_var.get().strip().upper()
        for entry in self.notice_entries:
            if selected and selected != "ALL" and entry["level"] != selected:
                continue
            level = entry["level"]
            tag = "log_info"
            if level == "WARN":
                tag = "log_warn"
            elif level == "ERROR":
                tag = "log_error"
            self.notice_list.insert(
                "",
                "end",
                values=(level, entry["time"], entry["message"]),
                tags=(tag,),
            )

    def _clear_notice_log(self) -> None:
        self.notice_entries = []
        self._refresh_notice_view()

    def _on_log_filter_changed(self, *_args) -> None:
        self._refresh_notice_view()

    def _notify_user(self, title: str, message: str) -> None:
        if self.tray_icon and self.tray_visible:
            try:
                self.tray_icon.notify(message, title)
                return
            except Exception:
                pass
        self._append_notice(message)

    def _set_status(self, text: str) -> None:
        ui_state = getattr(self, "ui_state", None)
        if ui_state:
            ui_state.set_status(text)
        else:
            self.root.after(0, lambda: self.status_var.set(text))
