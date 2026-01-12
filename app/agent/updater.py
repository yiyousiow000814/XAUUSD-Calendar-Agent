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


def _github_headers(token: str | None = None) -> dict[str, str]:
    headers = {
        "User-Agent": "XAUUSDCalendarAgent",
        "Accept": "application/vnd.github+json",
    }
    value = (token or "").strip()
    if value:
        headers["Authorization"] = f"Bearer {value}"
    return headers


def _http_error_message(exc: urllib.error.HTTPError, context: str) -> str:
    try:
        body = exc.read(4096).decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        body = ""
    detail = ""
    try:
        payload = json.loads(body) if body else None
        if isinstance(payload, dict) and payload.get("message"):
            detail = str(payload["message"]).strip()
    except Exception:  # noqa: BLE001
        detail = ""

    if exc.code in (401, 403):
        msg = f"{context} unauthorized"
        if detail:
            msg = f"{msg}: {detail}"
        return msg
    if exc.code == 404:
        msg = f"{context} not found"
        if detail:
            msg = f"{msg}: {detail}"
        return msg
    msg = f"{context} failed: HTTP {exc.code}"
    if detail:
        msg = f"{msg}: {detail}"
    return msg


def fetch_github_release(
    repo: str, asset_name: str | None = None, token: str | None = None
) -> UpdateInfo:
    api_url = f"https://api.github.com/repos/{repo}/releases/latest"
    request = urllib.request.Request(
        api_url,
        headers=_github_headers(token),
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read().decode("utf-8")
        data = json.loads(raw)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            if (token or "").strip():
                return UpdateInfo(
                    False,
                    "github release not found (check github_repo/token access or publish a release)",
                )
            return UpdateInfo(False, "no GitHub releases found")
        return UpdateInfo(False, _http_error_message(exc, "github release fetch"))
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
    token: str | None = None,
) -> Path:
    if target_dir:
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / "xauusd_calendar_update.exe"
    else:
        target = Path(tempfile.gettempdir()) / "xauusd_calendar_update.exe"

    downloaded = 0
    total: int | None = None
    request = urllib.request.Request(download_url, headers=_github_headers(token))
    with urllib.request.urlopen(request, timeout=30) as response:
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


def check_github_repo_access(
    repo: str, token: str | None = None, timeout: int = 10
) -> tuple[bool, str]:
    api_url = f"https://api.github.com/repos/{repo}"
    request = urllib.request.Request(api_url, headers=_github_headers(token))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", 200) or 200
        if int(status) >= 400:
            return False, f"github repo access failed: HTTP {status}"
        return True, "github repo access ok"
    except urllib.error.HTTPError as exc:
        return False, _http_error_message(exc, "github repo access")
    except Exception as exc:  # noqa: BLE001
        return False, f"github repo access failed: {exc}"


def fetch_github_branch_head_sha(
    repo: str, branch: str, token: str | None = None, timeout: int = 10
) -> tuple[bool, str, str]:
    branch_value = (branch or "main").strip() or "main"
    api_url = f"https://api.github.com/repos/{repo}/commits/{branch_value}"
    request = urllib.request.Request(api_url, headers=_github_headers(token))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
        data = json.loads(raw)
    except urllib.error.HTTPError as exc:
        return False, _http_error_message(exc, "github branch fetch"), ""
    except Exception as exc:  # noqa: BLE001
        return False, f"github branch fetch failed: {exc}", ""

    if not isinstance(data, dict):
        return False, "github branch payload invalid", ""
    sha = (data.get("sha") or "").strip()
    if not sha:
        return False, "github branch payload missing sha", ""
    return True, "github branch ok", sha
