import shutil
import tempfile
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path


@dataclass
class CalendarUpdateResult:
    ok: bool
    message: str
    files: int = 0


def _github_headers(token: str | None = None) -> dict[str, str]:
    headers = {
        "User-Agent": "XAUUSDCalendarAgent",
        "Accept": "application/vnd.github+json",
    }
    value = (token or "").strip()
    if value:
        headers["Authorization"] = f"Bearer {value}"
    return headers


def _download_to_file(url: str, target: Path, token: str | None = None) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers=_github_headers(token))
    with urllib.request.urlopen(request, timeout=60) as response, target.open(
        "wb"
    ) as handle:
        shutil.copyfileobj(response, handle)


def update_calendar_from_github(
    repo: str, branch: str, install_dir: Path, token: str | None = None
) -> CalendarUpdateResult:
    target_dir = install_dir / "data" / "Economic_Calendar"
    history_dir = install_dir / "data" / "event_history_index"
    branch_value = (branch or "main").strip() or "main"
    url = f"https://api.github.com/repos/{repo}/zipball/{branch_value}"
    tmp_root = Path(tempfile.mkdtemp(prefix="xauusd_calendar_"))
    zip_path = tmp_root / "repo.zip"
    extract_root = tmp_root / "extract"
    try:
        _download_to_file(url, zip_path, token=token)
    except urllib.error.HTTPError as exc:
        shutil.rmtree(tmp_root, ignore_errors=True)
        if exc.code in (401, 403):
            return CalendarUpdateResult(
                False, f"calendar download failed: unauthorized (HTTP {exc.code})"
            )
        if exc.code == 404:
            return CalendarUpdateResult(
                False,
                "calendar download failed: not found (check github_repo/github_branch/token access)",
            )
        return CalendarUpdateResult(False, f"calendar download failed: {exc}")
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(tmp_root, ignore_errors=True)
        return CalendarUpdateResult(False, f"calendar download failed: {exc}")

    try:
        with zipfile.ZipFile(zip_path) as archive:
            names = [item.filename for item in archive.infolist() if item.filename]
            calendar_prefix = None
            history_prefix = None
            for name in names:
                if "/data/Economic_Calendar/" in name:
                    base_prefix = name.split("/data/Economic_Calendar/")[0] + "/data/"
                    calendar_prefix = base_prefix + "Economic_Calendar/"
                    break
            for name in names:
                if "/data/event_history_index/" in name:
                    base_prefix = name.split("/data/event_history_index/")[0] + "/data/"
                    history_prefix = base_prefix + "event_history_index/"
                    break
            if not calendar_prefix:
                raise RuntimeError("calendar folder not found in repo archive")

            extracted_calendar = extract_root / "Economic_Calendar"
            extracted_calendar.mkdir(parents=True, exist_ok=True)
            extracted_history = None
            if history_prefix:
                extracted_history = extract_root / "event_history_index"
                extracted_history.mkdir(parents=True, exist_ok=True)
            calendar_files = 0
            history_files = 0
            for info in archive.infolist():
                name = info.filename
                if not name or name.endswith("/"):
                    continue
                if name.startswith(calendar_prefix):
                    rel = name[len(calendar_prefix) :]
                    dest = extracted_calendar / rel
                    calendar_files += 1
                elif history_prefix and name.startswith(history_prefix):
                    rel = name[len(history_prefix) :]
                    dest = extracted_history / rel if extracted_history else None
                    history_files += 1
                else:
                    continue
                if dest is None:
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as src, dest.open("wb") as out:
                    shutil.copyfileobj(src, out)

            if calendar_files == 0:
                raise RuntimeError("calendar archive contained no files")
            if history_prefix and history_files == 0:
                history_prefix = None

            target_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.rmtree(target_dir, ignore_errors=True)
            shutil.move(str(extracted_calendar), str(target_dir))
            if history_prefix and extracted_history and history_files:
                history_dir.parent.mkdir(parents=True, exist_ok=True)
                shutil.rmtree(history_dir, ignore_errors=True)
                shutil.move(str(extracted_history), str(history_dir))
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(tmp_root, ignore_errors=True)
        return CalendarUpdateResult(False, f"calendar update failed: {exc}")

    shutil.rmtree(tmp_root, ignore_errors=True)
    total_files = calendar_files + history_files
    if history_prefix and history_files:
        return CalendarUpdateResult(True, "calendar update ok", files=total_files)
    return CalendarUpdateResult(
        True, "calendar update ok (event history index missing)", files=total_files
    )
