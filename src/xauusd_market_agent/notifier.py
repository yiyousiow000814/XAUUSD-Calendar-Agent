from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class FileNotificationSink:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def emit(self, payload: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


class TelegramNotificationSink:
    def __init__(
        self,
        bot_token: str,
        chat_id: str,
        *,
        timeout_seconds: int = 10,
        session=None,
        enabled_levels: set[str] | None = None,
    ) -> None:
        self.bot_token = bot_token.strip()
        self.chat_id = chat_id.strip()
        self.timeout_seconds = timeout_seconds
        self.session = session
        self.enabled_levels = enabled_levels

    def emit(self, payload: dict[str, Any]) -> bool:
        return bool(self.send(payload)["sent"])

    def send(self, payload: dict[str, Any]) -> dict[str, Any]:
        level = str(payload.get("notification_level", "")).strip()
        if self.enabled_levels and level and level not in self.enabled_levels:
            return {
                "sent": False,
                "status": "filtered",
                "error": "",
                "notification_level": level,
            }
        if not self.bot_token or not self.chat_id:
            return {
                "sent": False,
                "status": "not_configured",
                "error": "Telegram bot token or chat id is not configured.",
                "notification_level": level,
            }
        text = str(payload.get("message", "")).strip()
        if not text:
            return {
                "sent": False,
                "status": "empty_message",
                "error": "Telegram message is empty.",
                "notification_level": level,
            }
        session = self.session
        if session is None:
            try:
                import requests
            except Exception as exc:
                return {
                    "sent": False,
                    "status": "failed",
                    "error": str(exc),
                    "notification_level": level,
                }
            session = requests
        try:
            response = session.post(
                f"https://api.telegram.org/bot{self.bot_token}/sendMessage",
                json={
                    "chat_id": self.chat_id,
                    "text": text,
                },
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
        except Exception as exc:
            return {
                "sent": False,
                "status": "failed",
                "error": str(exc),
                "notification_level": level,
            }
        return {
            "sent": True,
            "status": "sent",
            "error": "",
            "notification_level": level,
        }
