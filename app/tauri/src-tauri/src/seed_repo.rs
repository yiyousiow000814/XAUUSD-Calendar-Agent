use crate::config;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Err(format!("seed repo source not found: {}", src.display()));
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        let dst_path = dst.join(name);
        if path.is_dir() {
            copy_dir_recursive(&path, &dst_path)?;
        } else {
            if let Some(parent) = dst_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn has_calendar_data(repo_dir: &Path) -> bool {
    let base = repo_dir.join("data");
    base.join("Economic_Calendar")
        .read_dir()
        .ok()
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
        && base.join("event_history_index").exists()
}

pub fn ensure_seed_repo(app: &tauri::AppHandle) {
    let install_dir = config::install_dir();
    if has_calendar_data(&install_dir) {
        return;
    }

    let src_data = app
        .path()
        .resolve(
            PathBuf::from("seed-repo").join("data"),
            tauri::path::BaseDirectory::Resource,
        )
        .or_else(|_| {
            app.path().resolve(
                PathBuf::from("resources").join("seed-repo").join("data"),
                tauri::path::BaseDirectory::Resource,
            )
        });
    let Ok(src_data) = src_data else {
        return;
    };

    // Copy only if the bundled seed data exists.
    if !src_data.exists() {
        return;
    }

    // Seed into the install-root `data/` folder (next to the app executable).
    let dst_data = config::install_data_dir();
    let _ = fs::create_dir_all(&dst_data);
    let _ = copy_dir_recursive(&src_data, &dst_data);
}
