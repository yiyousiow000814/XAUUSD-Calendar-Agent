import json
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass
class UpdateInfo:
    ok: bool
    message: str
    version: str | None = None
    download_url: str | None = None


def fetch_github_release(repo: str, asset_name: str | None = None) -> UpdateInfo:
    api_url = f"https://api.github.com/repos/{repo}/releases/latest"
    request = urllib.request.Request(
        api_url,
        headers={"User-Agent": "XAUUSDCalendarAgent"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read().decode("utf-8")
        data = json.loads(raw)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return UpdateInfo(False, "no GitHub releases found")
        return UpdateInfo(False, f"github release fetch failed: {exc}")
    except Exception as exc:  # noqa: BLE001
        return UpdateInfo(False, f"github release fetch failed: {exc}")

    if not isinstance(data, dict):
        return UpdateInfo(False, "github release payload invalid")

    tag_name = data.get("tag_name") or ""
    assets = data.get("assets") or []
    if not isinstance(assets, list):
        assets = []

    download_url = None
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        name = asset.get("name")
        if asset_name and name == asset_name:
            download_url = asset.get("browser_download_url")
            break
    if not download_url:
        for asset in assets:
            if not isinstance(asset, dict):
                continue
            name = asset.get("name", "")
            if isinstance(name, str) and name.lower().endswith(".exe"):
                download_url = asset.get("browser_download_url")
                break

    if not download_url:
        return UpdateInfo(False, "github release asset not found")

    version = tag_name.lstrip("v") if isinstance(tag_name, str) else ""
    if not version:
        return UpdateInfo(False, "github release missing tag")

    return UpdateInfo(
        True, "github release ok", version=version, download_url=download_url
    )


def download_update(
    download_url: str,
    target_dir: Path | None = None,
    progress_callback: Callable[[int, int | None], None] | None = None,
) -> Path:
    if target_dir:
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / "xauusd_calendar_update.exe"
    else:
        target = Path(tempfile.gettempdir()) / "xauusd_calendar_update.exe"

    downloaded = 0
    total: int | None = None
    with urllib.request.urlopen(download_url, timeout=30) as response:
        length = None
        try:
            length = response.getheader("Content-Length")
        except Exception:  # noqa: BLE001
            length = None
        if length:
            try:
                total = int(length)
            except ValueError:
                total = None
        with target.open("wb") as handle:
            while True:
                chunk = response.read(1024 * 64)
                if not chunk:
                    break
                handle.write(chunk)
                downloaded += len(chunk)
                if progress_callback:
                    try:
                        progress_callback(downloaded, total)
                    except Exception:  # noqa: BLE001
                        pass
    return target
