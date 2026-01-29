use super::*;
use std::fs;
use std::io::{Read, Write};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub fn default_update_state() -> Value {
    json!({
        "ok": true,
        "phase": "idle",
        "message": "",
        "availableVersion": "",
        "progress": 0,
        "downloadedBytes": 0,
        "totalBytes": null,
        "lastCheckedAt": ""
    })
}

fn set_update_state(
    runtime: &mut RuntimeState,
    phase: &str,
    message: &str,
    ok: bool,
    available_version: Option<&str>,
) {
    if runtime.update_state.is_null() {
        runtime.update_state = default_update_state();
    }
    if let Some(obj) = runtime.update_state.as_object_mut() {
        obj.insert("ok".to_string(), Value::Bool(ok));
        obj.insert("phase".to_string(), Value::String(phase.to_string()));
        obj.insert("message".to_string(), Value::String(message.to_string()));
        if let Some(v) = available_version {
            obj.insert("availableVersion".to_string(), Value::String(v.to_string()));
        }
        obj.insert(
            "lastCheckedAt".to_string(),
            Value::String(now_display_time()),
        );
    }
}

fn set_update_progress(runtime: &mut RuntimeState, downloaded: u64, total: Option<u64>) {
    if runtime.update_state.is_null() {
        runtime.update_state = default_update_state();
    }
    if let Some(obj) = runtime.update_state.as_object_mut() {
        obj.insert(
            "downloadedBytes".to_string(),
            Value::Number(downloaded.into()),
        );
        match total {
            Some(value) => {
                obj.insert("totalBytes".to_string(), Value::Number(value.into()));
                let progress = if value > 0 {
                    (downloaded as f64 / value as f64).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let progress_value = serde_json::Number::from_f64(progress)
                    .unwrap_or_else(|| serde_json::Number::from(0));
                obj.insert("progress".to_string(), Value::Number(progress_value));
            }
            None => {
                obj.insert("totalBytes".to_string(), Value::Null);
                obj.insert("progress".to_string(), Value::Number(0.into()));
            }
        }
    }
}

fn filename_from_url(url: &str) -> String {
    url.split('/')
        .next_back()
        .unwrap_or("xauusd_calendar_update.exe")
        .trim()
        .to_string()
}

fn update_download_dir() -> Result<std::path::PathBuf, String> {
    let dir = config::appdata_dir().join("updates");
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create update dir: {e}"))?;
    Ok(dir)
}

fn spawn_installer(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Err("update installer not found".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let status = std::process::Command::new(path)
            .arg("/S")
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("failed to start installer: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "installer exited with code {}",
                status.code().unwrap_or(-1)
            ))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let status = std::process::Command::new(path)
            .status()
            .map_err(|e| format!("failed to start installer: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "installer exited with code {}",
                status.code().unwrap_or(-1)
            ))
        }
    }
}

fn maybe_prompt_update(runtime: &mut RuntimeState, version: &str) -> Option<Value> {
    if version.is_empty() {
        return None;
    }
    if runtime.update_prompted_version == version {
        return None;
    }
    runtime.update_prompted_version = version.to_string();
    let modal_id = format!("update-{}", now_ms());
    runtime.modal = json!({
        "id": modal_id,
        "title": "Update available",
        "message": format!("v{version} is ready.\n\nOpen Settings to update now, or check release notes."),
        "tone": "info"
    });
    Some(runtime.modal.clone())
}

pub(super) fn try_begin_github_token_check(app: tauri::AppHandle, token: String) {
    let token = token.trim().to_string();
    let runtime_state = app.state::<Mutex<RuntimeState>>();
    let mut runtime = runtime_state.lock().expect("runtime lock");

    if token.is_empty() {
        runtime.github_token_last_seen.clear();
        return;
    }

    if runtime.token_check_started {
        return;
    }

    if runtime.github_token_last_seen == token {
        return;
    }

    runtime.github_token_last_seen = token.clone();
    runtime.token_check_started = true;

    let modal_id = format!("github-token-{}", now_ms());
    runtime.modal = json!({
        "id": modal_id,
        "title": "GitHub Token",
        "message": "Checking token...",
        "tone": "info"
    });
    let modal_payload = runtime.modal.clone();
    drop(runtime);
    let _ = app.emit("xauusd:modal", modal_payload);

    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = verify_github_token_value(&token);

        let runtime_state = app_handle.state::<Mutex<RuntimeState>>();
        let state_for_updates = app_handle.state::<Mutex<RuntimeState>>();
        let mut runtime = runtime_state.lock().expect("runtime lock");

        let current_modal_id = runtime
            .modal
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let modal_still_active = current_modal_id == modal_id;

        match result {
            Ok(true) => {
                if modal_still_active {
                    runtime.modal = json!({
                        "id": modal_id,
                        "title": "GitHub Token",
                        "message": "Token verified.\n\nUpdating data...",
                        "tone": "info"
                    });
                }
                push_log(&mut runtime, "GitHub token verified.", "INFO");
                runtime.token_check_started = false;
                let modal_payload = if modal_still_active {
                    Some(runtime.modal.clone())
                } else {
                    None
                };
                drop(runtime);
                if let Some(payload) = modal_payload {
                    let _ = app_handle.emit("xauusd:modal", payload);
                }
                let _ = check_updates(app_handle.clone(), state_for_updates);
                return;
            }
            Ok(false) => {
                if modal_still_active {
                    runtime.modal = json!({
                        "id": modal_id,
                        "title": "GitHub Token",
                        "message": "Token Invalid.\n\nPlease check github_token in config.json",
                        "tone": "error"
                    });
                }
                push_log(&mut runtime, "GitHub token invalid.", "ERROR");
            }
            Err(msg) => {
                if modal_still_active {
                    runtime.modal = json!({
                        "id": modal_id,
                        "title": "GitHub Token",
                        "message": format!("Token check failed: {msg}\n\nPlease check github_token in config.json"),
                        "tone": "error"
                    });
                }
                push_log(
                    &mut runtime,
                    &format!("GitHub token check failed: {msg}"),
                    "ERROR",
                );
            }
        }
        runtime.token_check_started = false;
        if modal_still_active {
            let modal_payload = runtime.modal.clone();
            drop(runtime);
            let _ = app_handle.emit("xauusd:modal", modal_payload);
        }
    });
}

#[tauri::command]
pub fn get_update_state(state: tauri::State<'_, Mutex<RuntimeState>>) -> Value {
    let mut runtime = state.lock().expect("runtime lock");
    if runtime.update_state.is_null() {
        runtime.update_state = default_update_state();
    }
    runtime.update_state.clone()
}

#[tauri::command]
pub fn check_updates(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Value, String> {
    let cfg = config::load_config();
    let repo_slug = config::get_str(&cfg, "github_repo");
    let asset_name = config::get_str(&cfg, "github_release_asset_name");
    let token = config::get_str(&cfg, "github_token");
    let mut runtime = state.lock().expect("runtime lock");
    set_update_state(
        &mut runtime,
        "checking",
        "Checking for updates...",
        true,
        None,
    );
    runtime.update_release_url.clear();
    runtime.update_asset_url.clear();
    drop(runtime);

    tauri::async_runtime::spawn_blocking(move || {
        let parsed: Result<(String, String, String), String> = (|| {
            let url = format!("https://api.github.com/repos/{repo_slug}/releases/latest");
            let agent = ureq::AgentBuilder::new()
                .timeout_connect(std::time::Duration::from_secs(5))
                .timeout_read(std::time::Duration::from_secs(10))
                .timeout_write(std::time::Duration::from_secs(10))
                .build();
            let mut req = agent
                .get(&url)
                .set("User-Agent", "XAUUSDCalendarAgent")
                .set("Accept", "application/vnd.github+json")
                .set("X-GitHub-Api-Version", "2022-11-28");
            if !token.is_empty() {
                req = req.set("Authorization", &format!("Bearer {token}"));
            }
            let resp = req
                .call()
                .map_err(|err| format!("GitHub request failed: {err}"))?;
            let body: serde_json::Value = resp
                .into_json()
                .map_err(|e| format!("failed to parse GitHub response: {e}"))?;
            let tag = body.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
            let available = normalize_version_tag(tag);
            if available.is_empty() {
                return Err("GitHub release tag_name missing".to_string());
            }
            let release_url = body
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut asset_url = String::new();
            if let Some(assets) = body.get("assets").and_then(|v| v.as_array()) {
                for a in assets {
                    let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if !asset_name.is_empty() && name == asset_name {
                        asset_url = a
                            .get("browser_download_url")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        break;
                    }
                }
            }
            if asset_url.is_empty() && !release_url.is_empty() {
                asset_url = release_url.clone();
            }
            Ok((available, release_url, asset_url))
        })();

        let runtime_state = app.state::<Mutex<RuntimeState>>();
        let mut runtime = runtime_state.lock().expect("runtime lock");
        match parsed {
            Ok((available, release_url, asset_url)) => {
                runtime.update_release_url = release_url.clone();
                runtime.update_asset_url = asset_url.clone();
                let current = env!("APP_VERSION");
                if cmp_versions(&available, current) == Ordering::Greater {
                    set_update_state(
                        &mut runtime,
                        "available",
                        &format!("Update available: {available}"),
                        true,
                        Some(&available),
                    );
                    push_log(
                        &mut runtime,
                        &format!("Update available: {available}"),
                        "INFO",
                    );
                    let modal_payload = maybe_prompt_update(&mut runtime, &available);
                    drop(runtime);
                    if let Some(payload) = modal_payload {
                        let _ = app.emit("xauusd:modal", payload);
                    }
                } else {
                    set_update_state(&mut runtime, "idle", "Up to date", true, Some(&available));
                }
            }
            Err(msg) => {
                set_update_state(&mut runtime, "error", &msg, false, None);
                push_log(
                    &mut runtime,
                    &format!("Update check failed: {msg}"),
                    "ERROR",
                );
            }
        }
    });

    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn update_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Value, String> {
    let (url, available_version) = {
        let runtime = state.lock().expect("runtime lock");
        let version = runtime
            .update_state
            .get("availableVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        (runtime.update_asset_url.trim().to_string(), version)
    };
    if url.is_empty() {
        return Ok(json!({"ok": false, "message": "Update URL not available"}));
    }
    {
        let mut runtime = state.lock().expect("runtime lock");
        set_update_state(
            &mut runtime,
            "downloading",
            "Downloading...",
            true,
            if available_version.is_empty() {
                None
            } else {
                Some(&available_version)
            },
        );
        set_update_progress(&mut runtime, 0, None);
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = config::load_config();
        let token = config::get_str(&cfg, "github_token");
        let asset_name = config::get_str(&cfg, "github_release_asset_name");
        let filename = if !asset_name.is_empty() {
            asset_name
        } else {
            filename_from_url(&url)
        };
        let target_dir = match update_download_dir() {
            Ok(dir) => dir,
            Err(msg) => {
                let state = app_handle.state::<Mutex<RuntimeState>>();
                let mut runtime = state.lock().expect("runtime lock");
                set_update_state(&mut runtime, "error", &msg, false, None);
                push_log(
                    &mut runtime,
                    &format!("Update download failed: {msg}"),
                    "ERROR",
                );
                return;
            }
        };
        let target_path = target_dir.join(filename);
        let download_result: Result<(), String> = (|| {
            let agent = ureq::AgentBuilder::new()
                .timeout_connect(std::time::Duration::from_secs(10))
                .timeout_read(std::time::Duration::from_secs(30))
                .timeout_write(std::time::Duration::from_secs(30))
                .build();
            let mut req = agent.get(&url).set("User-Agent", "XAUUSDCalendarAgent");
            if !token.is_empty() {
                req = req.set("Authorization", &format!("Bearer {token}"));
            }
            let resp = req.call().map_err(|e| format!("download failed: {e}"))?;
            let total = resp
                .header("Content-Length")
                .and_then(|v| v.parse::<u64>().ok());
            let mut reader = resp.into_reader();
            let mut file = fs::File::create(&target_path)
                .map_err(|e| format!("failed to create installer: {e}"))?;
            let mut buf = [0u8; 64 * 1024];
            let mut downloaded: u64 = 0;
            loop {
                let n = reader
                    .read(&mut buf)
                    .map_err(|e| format!("read failed: {e}"))?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n])
                    .map_err(|e| format!("write failed: {e}"))?;
                downloaded += n as u64;
                let state = app_handle.state::<Mutex<RuntimeState>>();
                let mut runtime = state.lock().expect("runtime lock");
                set_update_progress(&mut runtime, downloaded, total);
            }
            Ok(())
        })();

        if let Err(msg) = download_result {
            let state = app_handle.state::<Mutex<RuntimeState>>();
            let mut runtime = state.lock().expect("runtime lock");
            set_update_state(&mut runtime, "error", &msg, false, None);
            push_log(
                &mut runtime,
                &format!("Update download failed: {msg}"),
                "ERROR",
            );
            return;
        }

        {
            let state = app_handle.state::<Mutex<RuntimeState>>();
            let mut runtime = state.lock().expect("runtime lock");
            set_update_state(&mut runtime, "installing", "Installing...", true, None);
            set_update_progress(&mut runtime, 1, Some(1));
        }

        if let Err(msg) = spawn_installer(&target_path) {
            let state = app_handle.state::<Mutex<RuntimeState>>();
            let mut runtime = state.lock().expect("runtime lock");
            set_update_state(&mut runtime, "error", &msg, false, None);
            push_log(
                &mut runtime,
                &format!("Update install failed: {msg}"),
                "ERROR",
            );
            return;
        }

        {
            let state = app_handle.state::<Mutex<RuntimeState>>();
            let mut runtime = state.lock().expect("runtime lock");
            set_update_state(&mut runtime, "restarting", "Restarting...", true, None);
        }
        app_handle.exit(0);
    });

    Ok(json!({"ok": true}))
}

fn verify_github_token_value(token: &str) -> Result<bool, String> {
    let token = token.trim();
    if token.is_empty() {
        return Ok(false);
    }

    let url = "https://api.github.com/user";
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(5))
        .timeout_read(std::time::Duration::from_secs(8))
        .timeout_write(std::time::Duration::from_secs(8))
        .build();
    let resp = agent
        .get(url)
        .set("User-Agent", "XAUUSDCalendarAgent")
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("Authorization", &format!("Bearer {token}"))
        .call();

    match resp {
        Ok(r) => Ok((200..=299).contains(&r.status())),
        Err(ureq::Error::Status(401, _)) => Ok(false),
        Err(ureq::Error::Status(code, _)) => Err(format!("GitHub responded with HTTP {code}")),
        Err(e) => Err(format!("{e}")),
    }
}
