from __future__ import annotations

import json
import sys

from .notifier import TelegramNotificationSink


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "status": "failed", "error": f"Invalid JSON: {exc}"}))
        return 1
    sink = TelegramNotificationSink(
        bot_token=str(payload.get("botToken", "")),
        chat_id=str(payload.get("chatId", "")),
        timeout_seconds=int(payload.get("timeoutSeconds") or 10),
        enabled_levels=set(payload.get("levels") or []),
    )
    result = sink.send(
        {
            "message": "[XAUUSD Situation Alert]\nTelegram test message from Market Agent.",
            "notification_level": "level_3",
        }
    )
    print(
        json.dumps(
            {
                "ok": result.get("status") == "sent",
                "status": result.get("status", "failed"),
                "message": result.get("message", "Telegram test completed."),
                "error": result.get("error", ""),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
