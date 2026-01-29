from __future__ import annotations

import json
import re
from pathlib import Path

INDEX_PATH = Path("data/event_history_index/event_history_by_event.index.json")
OUTPUT_PATH = Path("app/webui/src/data/event_notes.json")

# Enforce the repo's "hand-written notes" direction:
# - Never generate text automatically.
# - Keep the JSON in sync with the event index (add missing keys with empty notes).
# - Provide a quality report to guide manual rewrites.
BANNED_PHRASES = [
    re.compile(r"\btracks\b", re.IGNORECASE),
    re.compile(r"\bgrowth indicator\b", re.IGNORECASE),
]


def load_json(path: Path) -> object:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def normalize_notes(raw: object) -> dict[str, dict[str, str]]:
    if not isinstance(raw, dict):
        raise SystemExit(f"Invalid notes JSON (expected object): {OUTPUT_PATH}")
    out: dict[str, dict[str, str]] = {}
    for key, value in raw.items():
        if isinstance(value, dict) and isinstance(value.get("note", ""), str):
            out[str(key)] = {"note": value.get("note", "")}
        elif isinstance(value, str):
            out[str(key)] = {"note": value}
        else:
            out[str(key)] = {"note": ""}
    return out


def count_sentences(text: str) -> int:
    # Simple heuristic: count terminal punctuation.
    return len(re.findall(r"[.!?](?:\s|$)", text.strip()))


def main() -> None:
    if not INDEX_PATH.exists():
        raise SystemExit(f"Missing index file: {INDEX_PATH}")

    index_payload = load_json(INDEX_PATH)
    event_ids = sorted((index_payload or {}).get("index", {}).keys())
    if not event_ids:
        raise SystemExit(f"Index file has no events: {INDEX_PATH}")

    existing_raw = load_json(OUTPUT_PATH) if OUTPUT_PATH.exists() else {}
    notes = normalize_notes(existing_raw)

    missing = [event_id for event_id in event_ids if event_id not in notes]
    extras = [event_id for event_id in notes.keys() if event_id not in set(event_ids)]

    for event_id in missing:
        notes[event_id] = {"note": ""}

    banned_hits = 0
    long_hits = 0
    empty_hits = 0
    for item in notes.values():
        note = (item.get("note") or "").strip()
        if not note:
            empty_hits += 1
            continue
        if any(p.search(note) for p in BANNED_PHRASES):
            banned_hits += 1
        if count_sentences(note) > 2:
            long_hits += 1

    print("Event notes report")
    print(f"- index events: {len(event_ids)}")
    print(f"- notes entries: {len(notes)}")
    print(f"- missing entries added with empty note: {len(missing)}")
    print(f"- extra entries (not in index): {len(extras)}")
    print(f"- empty notes: {empty_hits}")
    print(f"- notes containing banned phrases: {banned_hits}")
    print(f"- notes over 2 sentences (heuristic): {long_hits}")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(notes, indent=2, ensure_ascii=True, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
