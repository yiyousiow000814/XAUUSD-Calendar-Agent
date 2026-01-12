import shutil
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path


@dataclass
class CalendarUpdateResult:
    ok: bool
    message: str
    files: int = 0


def _download_to_file(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "XAUUSDCalendarAgent"})
    with urllib.request.urlopen(request, timeout=60) as response, target.open(
        "wb"
    ) as handle:
        shutil.copyfileobj(response, handle)


def update_calendar_from_github(
    repo: str, branch: str, install_dir: Path
) -> CalendarUpdateResult:
    target_dir = install_dir / "data" / "Economic_Calendar"
    url = f"https://github.com/{repo}/archive/refs/heads/{branch}.zip"
    tmp_root = Path(tempfile.mkdtemp(prefix="xauusd_calendar_"))
    zip_path = tmp_root / "repo.zip"
    extract_root = tmp_root / "extract"
    try:
        _download_to_file(url, zip_path)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(tmp_root, ignore_errors=True)
        return CalendarUpdateResult(False, f"calendar download failed: {exc}")

    try:
        with zipfile.ZipFile(zip_path) as archive:
            names = [item.filename for item in archive.infolist() if item.filename]
            prefix = None
            for name in names:
                if "/data/Economic_Calendar/" in name:
                    prefix = (
                        name.split("/data/Economic_Calendar/")[0]
                        + "/data/Economic_Calendar/"
                    )
                    break
            if not prefix:
                raise RuntimeError("calendar folder not found in repo archive")

            extracted_calendar = extract_root / "Economic_Calendar"
            extracted_calendar.mkdir(parents=True, exist_ok=True)
            files = 0
            for info in archive.infolist():
                name = info.filename
                if not name or not name.startswith(prefix) or name.endswith("/"):
                    continue
                rel = name[len(prefix) :]
                dest = extracted_calendar / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as src, dest.open("wb") as out:
                    shutil.copyfileobj(src, out)
                files += 1

            if files == 0:
                raise RuntimeError("calendar archive contained no files")

            target_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.rmtree(target_dir, ignore_errors=True)
            shutil.move(str(extracted_calendar), str(target_dir))
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(tmp_root, ignore_errors=True)
        return CalendarUpdateResult(False, f"calendar update failed: {exc}")

    shutil.rmtree(tmp_root, ignore_errors=True)
    return CalendarUpdateResult(True, "calendar update ok", files=files)
