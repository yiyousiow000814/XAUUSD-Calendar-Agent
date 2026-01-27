use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub struct SyncResult {
    pub copied: i64,
    pub deleted: i64,
    pub skipped: i64,
}

fn iter_files(root: &Path) -> HashMap<String, PathBuf> {
    let mut files = HashMap::new();
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .to_string();
        files.insert(rel, entry.path().to_path_buf());
    }
    files
}

fn should_copy(src: &Path, dst: &Path) -> bool {
    if !dst.exists() {
        return true;
    }
    let src_meta = src.metadata();
    let dst_meta = dst.metadata();
    if src_meta.is_err() || dst_meta.is_err() {
        return true;
    }
    let src_meta = src_meta.unwrap();
    let dst_meta = dst_meta.unwrap();
    if src_meta.len() != dst_meta.len() {
        return true;
    }
    let src_mtime = src_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dst_mtime = dst_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    src_mtime != dst_mtime
}

pub fn mirror_sync(src_dir: &Path, dst_dir: &Path) -> Result<SyncResult, String> {
    if !src_dir.exists() {
        return Err(format!("Source not found: {}", src_dir.display()));
    }
    fs::create_dir_all(dst_dir).map_err(|e| e.to_string())?;

    let src_files = iter_files(src_dir);
    let dst_files = iter_files(dst_dir);

    let mut result = SyncResult::default();

    for (rel, src_path) in src_files.iter() {
        let dst_path = dst_dir.join(rel);
        if let Some(parent) = dst_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if should_copy(src_path, &dst_path) {
            fs::copy(src_path, &dst_path).map_err(|e| e.to_string())?;
            result.copied += 1;
        } else {
            result.skipped += 1;
        }
    }

    for (rel, dst_path) in dst_files.iter() {
        if rel == ".xauusd_calendar_agent_managed_output" {
            continue;
        }
        if !src_files.contains_key(rel) {
            if fs::remove_file(dst_path).is_ok() {
                result.deleted += 1;
            }
        }
    }

    for entry in walkdir::WalkDir::new(dst_dir)
        .contents_first(true)
        .into_iter()
        .flatten()
    {
        if entry.file_type().is_dir() {
            let p = entry.path();
            let _ = fs::remove_dir(p);
        }
    }

    Ok(result)
}
