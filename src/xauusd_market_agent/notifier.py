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
    ) -> None:
        self.bot_token = bot_token.strip()
        self.chat_id = chat_id.strip()
        self.timeout_seconds = timeout_seconds
        self.session = session

    def emit(self, payload: dict[str, Any]) -> bool:
        if not self.bot_token or not self.chat_id:
            return False
        text = str(payload.get("message", "")).strip()
        if not text:
            return False
        session = self.session
        if session is None:
            try:
                import requests
            except Exception:
                return False
            session = requests
        response = session.post(
            f"https://api.telegram.org/bot{self.bot_token}/sendMessage",
            json={
                "chat_id": self.chat_id,
                "text": text,
            },
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        return True
