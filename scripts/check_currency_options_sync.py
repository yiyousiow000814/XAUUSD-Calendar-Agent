#!/usr/bin/env python3
"""Verify Python/TS currency option lists stay in sync.

We intentionally keep a fixed currency list for UX predictability, but the list
is defined in both the Python agent and the Web UI. This script prevents the
two sources from drifting.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PY_PATH = REPO_ROOT / "app" / "agent" / "currency_options.py"
TS_PATH = REPO_ROOT / "app" / "webui" / "src" / "constants" / "currencyOptions.ts"


def read_py_list(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.AnnAssign):
            target = node.target
            if isinstance(target, ast.Name) and target.id == "CURRENCY_OPTIONS":
                if node.value is None:
                    raise ValueError("CURRENCY_OPTIONS has no value")
                if not isinstance(node.value, (ast.List, ast.Tuple)):
                    raise ValueError("CURRENCY_OPTIONS is not a list/tuple literal")
                value = ast.literal_eval(node.value)
                if not isinstance(value, list):
                    raise ValueError("CURRENCY_OPTIONS did not evaluate to a list")
                return [str(item) for item in value]
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "CURRENCY_OPTIONS":
                if not isinstance(node.value, (ast.List, ast.Tuple)):
                    raise ValueError("CURRENCY_OPTIONS is not a list/tuple literal")
                value = ast.literal_eval(node.value)
                if not isinstance(value, list):
                    raise ValueError("CURRENCY_OPTIONS did not evaluate to a list")
                return [str(item) for item in value]
    raise ValueError("CURRENCY_OPTIONS not found in Python file")


def read_ts_list(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    marker = "export const CURRENCY_OPTIONS"
    start = text.find(marker)
    if start < 0:
        raise ValueError("CURRENCY_OPTIONS export not found in TS file")
    # Take a local slice around the array literal to keep parsing simple.
    slice_text = text[start : start + 20_000]
    m = re.search(r"export const CURRENCY_OPTIONS\s*=\s*\[(.*?)\]\s*as const", slice_text, re.S)
    if not m:
        raise ValueError("Could not locate CURRENCY_OPTIONS array literal in TS file")
    body = m.group(1)
    return re.findall(r'"([^"]+)"', body)


def main() -> int:
    py = read_py_list(PY_PATH)
    ts = read_ts_list(TS_PATH)

    if py != ts:
        print("Currency option lists are out of sync:", file=sys.stderr)
        print(f"- {PY_PATH.as_posix()} ({len(py)} items)", file=sys.stderr)
        print(f"- {TS_PATH.as_posix()} ({len(ts)} items)", file=sys.stderr)
        # Print a small, stable diff to help fix quickly.
        py_set = set(py)
        ts_set = set(ts)
        missing_in_ts = sorted(py_set - ts_set)
        missing_in_py = sorted(ts_set - py_set)
        if missing_in_ts:
            print(f"Missing in TS: {', '.join(missing_in_ts)}", file=sys.stderr)
        if missing_in_py:
            print(f"Missing in Python: {', '.join(missing_in_py)}", file=sys.stderr)
        # Also show the first index where ordering diverges.
        for i, (a, b) in enumerate(zip(py, ts)):
            if a != b:
                print(f"Order diverges at index {i}: python={a!r} ts={b!r}", file=sys.stderr)
                break
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
