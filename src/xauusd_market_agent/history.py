from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_alert_history(path: Path) -> list[dict[str, Any]]:
    if not Path(path).exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    rows.sort(key=lambda item: item.get("time", ""), reverse=True)
    return rows
