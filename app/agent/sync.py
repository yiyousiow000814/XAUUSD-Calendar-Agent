import os
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass
class SyncResult:
    copied: int
    deleted: int
    skipped: int


def _iter_files(root: Path) -> dict[str, Path]:
    files = {}
    for path in root.rglob("*"):
        if path.is_file():
            rel = str(path.relative_to(root))
            files[rel] = path
    return files


def _should_copy(src: Path, dst: Path) -> bool:
    if not dst.exists():
        return True
    try:
        return (src.stat().st_size != dst.stat().st_size) or (
            int(src.stat().st_mtime) != int(dst.stat().st_mtime)
        )
    except OSError:
        return True


def mirror_sync(src_dir: Path, dst_dir: Path) -> SyncResult:
    if not src_dir.exists():
        raise FileNotFoundError(f"Source not found: {src_dir}")
    dst_dir.mkdir(parents=True, exist_ok=True)

    src_files = _iter_files(src_dir)
    dst_files = _iter_files(dst_dir)

    copied = 0
    skipped = 0
    for rel, src_path in src_files.items():
        dst_path = dst_dir / rel
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        if _should_copy(src_path, dst_path):
            shutil.copy2(src_path, dst_path)
            copied += 1
        else:
            skipped += 1

    deleted = 0
    for rel, dst_path in dst_files.items():
        if rel not in src_files:
            try:
                dst_path.unlink()
                deleted += 1
            except OSError:
                continue

    for root, dirs, files in os.walk(dst_dir, topdown=False):
        if not dirs and not files:
            try:
                Path(root).rmdir()
            except OSError:
                pass

    return SyncResult(copied=copied, deleted=deleted, skipped=skipped)
