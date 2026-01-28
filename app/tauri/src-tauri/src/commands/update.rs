use super::*;

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
pub fn update_now(state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    let url = {
        let runtime = state.lock().expect("runtime lock");
        runtime.update_asset_url.trim().to_string()
    };
    if url.is_empty() {
        return Ok(json!({"ok": false, "message": "Update URL not available"}));
    }
    let ok = open_target(&url);
    if ok {
        Ok(json!({"ok": true}))
    } else {
        Ok(json!({"ok": false, "message": "failed to open update url"}))
    }
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
