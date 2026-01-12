import os
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

try:
    import signal
except Exception:  # noqa: BLE001
    signal = None


@dataclass
class GitResult:
    ok: bool
    message: str
    output: str = ""


def _run_git(repo_path: Path, args: list[str]) -> subprocess.CompletedProcess:
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW
    return subprocess.run(
        ["git", "-C", str(repo_path), *args],
        check=False,
        capture_output=True,
        text=True,
        creationflags=creationflags,
    )


def clone_repo(repo_url: str, target_path: Path) -> GitResult:
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW
    result = subprocess.run(
        ["git", "clone", repo_url, str(target_path)],
        check=False,
        capture_output=True,
        text=True,
        creationflags=creationflags,
    )
    if result.returncode != 0:
        return GitResult(False, "git clone failed", result.stderr.strip())
    return GitResult(True, "git clone ok", result.stdout.strip())


def normalize_repo_slug(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    if re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", raw):
        slug = raw.lower()
        if slug.endswith(".git"):
            slug = slug[: -len(".git")]
        return slug
    match = re.search(
        r"github\.com[:/]+([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:\\.git)?/?$",
        raw,
    )
    if match:
        slug = match.group(1).lower()
        if slug.endswith(".git"):
            slug = slug[: -len(".git")]
        return slug
    slug = raw.lower().rstrip("/")
    if slug.endswith(".git"):
        slug = slug[: -len(".git")]
    return slug


def get_origin_url(repo_path: Path) -> GitResult:
    result = _run_git(repo_path, ["config", "--get", "remote.origin.url"])
    if result.returncode != 0:
        return GitResult(False, "git origin url missing", result.stderr.strip())
    return GitResult(True, "git origin url ok", result.stdout.strip())


def get_origin_repo_slug(repo_path: Path) -> GitResult:
    origin = get_origin_url(repo_path)
    if not origin.ok:
        return origin
    slug = normalize_repo_slug(origin.output)
    if not slug:
        return GitResult(False, "git origin url empty", origin.output)
    return GitResult(True, "git origin repo ok", slug)


def is_git_repo_usable(repo_path: Path) -> GitResult:
    check = _run_git(repo_path, ["rev-parse", "--is-inside-work-tree"])
    if check.returncode != 0 or check.stdout.strip().lower() != "true":
        return GitResult(
            False, "git repo not usable", (check.stderr or check.stdout).strip()
        )
    head = _run_git(repo_path, ["rev-parse", "HEAD"])
    if head.returncode != 0:
        return GitResult(
            False, "git head missing", (head.stderr or head.stdout).strip()
        )
    return GitResult(True, "git repo usable", head.stdout.strip())


def get_status_porcelain(repo_path: Path) -> GitResult:
    result = _run_git(repo_path, ["status", "--porcelain"])
    if result.returncode != 0:
        return GitResult(False, "git status failed", result.stderr.strip())
    return GitResult(True, "git status ok", result.stdout)


def clone_repo_with_progress(
    repo_url: str,
    target_path: Path,
    on_progress: Callable[[int, str], None] | None = None,
    on_process: Callable[[subprocess.Popen], None] | None = None,
) -> GitResult:
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW

    process = subprocess.Popen(
        ["git", "clone", "--progress", repo_url, str(target_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=(os.name != "nt"),
        creationflags=creationflags,
    )
    if on_process:
        try:
            on_process(process)
        except Exception:
            pass

    stderr_lines: list[str] = []
    last_percent = -1
    if process.stderr is not None:
        for line in process.stderr:
            text_line = line.rstrip()
            if text_line:
                stderr_lines.append(text_line)
            match = re.search(r"Receiving objects:\\s+(\\d+)%", text_line)
            if not match:
                match = re.search(r"Resolving deltas:\\s+(\\d+)%", text_line)
            if match:
                percent = int(match.group(1))
                if percent != last_percent:
                    last_percent = percent
                    if on_progress:
                        try:
                            on_progress(percent, text_line)
                        except Exception:
                            pass

    process.wait()
    if process.returncode != 0:
        tail = "\n".join(stderr_lines[-20:]).strip()
        return GitResult(False, "git clone failed", tail or "git clone failed")
    return GitResult(True, "git clone ok", "")


def clone_repo_with_progress_into_dir(
    repo_url: str,
    workdir: Path,
    on_progress: Callable[[int, str], None] | None = None,
    on_process: Callable[[subprocess.Popen], None] | None = None,
) -> GitResult:
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW

    try:
        workdir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        return GitResult(False, "git clone failed", str(exc))

    process = subprocess.Popen(
        ["git", "clone", "--progress", repo_url, "."],
        cwd=str(workdir),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=(os.name != "nt"),
        creationflags=creationflags,
    )
    if on_process:
        try:
            on_process(process)
        except Exception:
            pass

    stderr_lines: list[str] = []
    last_percent = -1
    if process.stderr is not None:
        for line in process.stderr:
            text_line = line.rstrip()
            if text_line:
                stderr_lines.append(text_line)
            match = re.search(r"Receiving objects:\\s+(\\d+)%", text_line)
            if not match:
                match = re.search(r"Resolving deltas:\\s+(\\d+)%", text_line)
            if match:
                percent = int(match.group(1))
                if percent != last_percent:
                    last_percent = percent
                    if on_progress:
                        try:
                            on_progress(percent, text_line)
                        except Exception:
                            pass

    process.wait()
    if process.returncode != 0:
        tail = "\n".join(stderr_lines[-20:]).strip()
        return GitResult(False, "git clone failed", tail or "git clone failed")
    return GitResult(True, "git clone ok", "")


def terminate_process_tree(pid: int, timeout_s: float = 2.5) -> GitResult:
    if not pid:
        return GitResult(False, "terminate failed", "missing pid")
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW
        result = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            check=False,
            capture_output=True,
            text=True,
            creationflags=creationflags,
        )
        if result.returncode != 0:
            return GitResult(
                False,
                "terminate failed",
                (result.stderr or result.stdout).strip() or "taskkill failed",
            )
        return GitResult(True, "terminated", "")

    if signal is None:
        return GitResult(False, "terminate failed", "signal unavailable")
    try:
        pgid = os.getpgid(pid)
    except Exception as exc:  # noqa: BLE001
        return GitResult(False, "terminate failed", str(exc))
    try:
        current_pgid = os.getpgrp()
    except Exception:  # noqa: BLE001
        current_pgid = None
    try:
        if current_pgid is not None and pgid == current_pgid:
            os.kill(pid, signal.SIGTERM)
        else:
            os.killpg(pgid, signal.SIGTERM)
    except Exception:  # noqa: BLE001
        pass
    deadline = time.time() + max(0.1, float(timeout_s))
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except OSError:
            return GitResult(True, "terminated", "")
        time.sleep(0.05)
    try:
        if current_pgid is not None and pgid == current_pgid:
            os.kill(pid, signal.SIGKILL)
        else:
            os.killpg(pgid, signal.SIGKILL)
    except Exception:  # noqa: BLE001
        pass
    return GitResult(True, "terminated", "")


def _unique_ints(values: Iterable[int]) -> list[int]:
    seen: set[int] = set()
    ordered: list[int] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        ordered.append(int(value))
    return ordered


def find_git_clone_pids_by_repo_url(repo_url: str) -> list[int]:
    needle = (repo_url or "").strip().lower()
    if not needle:
        return []
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW
        script = (
            "Get-CimInstance Win32_Process -Filter \"Name='git.exe'\" | "
            "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            check=False,
            capture_output=True,
            text=True,
            creationflags=creationflags,
        )
        if result.returncode != 0:
            return []
        raw = (result.stdout or "").strip()
        if not raw:
            return []
        try:
            import json  # local import to keep startup light

            data = json.loads(raw)
        except Exception:  # noqa: BLE001
            return []
        items = data if isinstance(data, list) else [data]
        pids: list[int] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            pid_raw = item.get("ProcessId")
            cmd = (item.get("CommandLine") or "").lower()
            if " clone " not in f" {cmd} ":
                continue
            if needle not in cmd:
                continue
            try:
                pid = int(pid_raw)
            except Exception:  # noqa: BLE001
                continue
            pids.append(pid)
        return _unique_ints(pids)

    try:
        result = subprocess.run(
            ["ps", "-eo", "pid,args"],
            check=False,
            capture_output=True,
            text=True,
        )
    except Exception:  # noqa: BLE001
        return []
    if result.returncode != 0:
        return []
    pids: list[int] = []
    for line in (result.stdout or "").splitlines():
        text_line = line.strip()
        if not text_line:
            continue
        parts = text_line.split(maxsplit=1)
        if len(parts) < 2:
            continue
        pid_str, cmd = parts[0], parts[1].lower()
        if " git " not in f" {cmd} " and not cmd.startswith("git "):
            continue
        if " clone " not in f" {cmd} ":
            continue
        if needle not in cmd:
            continue
        try:
            pids.append(int(pid_str))
        except Exception:  # noqa: BLE001
            continue
    return _unique_ints(pids)


def terminate_git_clone_processes_by_repo_url(
    repo_url: str, max_pids: int = 6
) -> GitResult:
    pids = find_git_clone_pids_by_repo_url(repo_url)[: max(0, int(max_pids))]
    if not pids:
        return GitResult(True, "no matching git clone processes", "")
    failures: list[str] = []
    for pid in pids:
        result = terminate_process_tree(pid)
        if not result.ok:
            failures.append(f"{pid}:{result.output or result.message}")
    if failures:
        return GitResult(False, "terminate failed", "; ".join(failures))
    return GitResult(True, "terminated", f"killed={len(pids)}")


def fetch_origin(repo_path: Path) -> GitResult:
    result = _run_git(repo_path, ["fetch", "origin", "main"])
    if result.returncode != 0:
        return GitResult(False, "git fetch failed", result.stderr.strip())
    return GitResult(True, "git fetch ok", result.stdout.strip())


def get_head_sha(repo_path: Path) -> GitResult:
    result = _run_git(repo_path, ["rev-parse", "HEAD"])
    if result.returncode != 0:
        return GitResult(False, "git rev-parse HEAD failed", result.stderr.strip())
    return GitResult(True, "git head sha ok", result.stdout.strip())


def get_head_branch(repo_path: Path) -> GitResult:
    result = _run_git(repo_path, ["rev-parse", "--abbrev-ref", "HEAD"])
    if result.returncode != 0:
        return GitResult(
            False, "git rev-parse HEAD branch failed", result.stderr.strip()
        )
    return GitResult(True, "git head branch ok", result.stdout.strip())


def get_origin_sha(repo_path: Path) -> GitResult:
    result = _run_git(repo_path, ["rev-parse", "origin/main"])
    if result.returncode != 0:
        return GitResult(
            False, "git rev-parse origin/main failed", result.stderr.strip()
        )
    return GitResult(True, "git origin sha ok", result.stdout.strip())


def pull_origin_main(repo_path: Path) -> GitResult:
    result = _run_git(repo_path, ["pull", "origin", "main"])
    if result.returncode != 0:
        return GitResult(False, "git pull failed", result.stderr.strip())
    return GitResult(True, "git pull ok", result.stdout.strip())
