use super::*;

pub(super) fn spawn_pull(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<RuntimeState>>,
    reason: &str,
) {
    let cfg = config::load_config();
    let repo_slug = config::get_str(&cfg, "github_repo");
    let branch = config::get_str(&cfg, "github_branch");
    let work_data_dir = config::working_data_dir(&cfg);
    let work_root = config::working_root_dir(&cfg);
    {
        let mut runtime = state.lock().expect("runtime lock");
        if runtime.pull_active {
            return;
        }
        runtime.pull_active = true;
        push_log(&mut runtime, reason, "INFO");
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> Result<String, String> {
            // Pull only fetches `data/` (no full-repo checkout), and never persists a visible `repo/`
            // directory under `user-data/`.
            let remote_sha = git_ops::ls_remote_head_sha(&repo_slug, &branch).unwrap_or_default();
            let last_sha = {
                let cfg = config::load_config();
                config::get_str(&cfg, "last_pull_sha")
            };
            if !remote_sha.is_empty()
                && !last_sha.is_empty()
                && remote_sha == last_sha
                && work_data_dir.join("Economic_Calendar").exists()
            {
                return Ok(remote_sha);
            }

            let tmp = std::env::temp_dir().join(format!(
                "xauusd-calendar-agent-pull-{}-{}",
                std::process::id(),
                now_ms()
            ));
            if tmp.exists() {
                let _ = std::fs::remove_dir_all(&tmp);
            }
            let sha = git_ops::clone_sparse_data(&tmp, &repo_slug, &branch)?;
            let src = tmp.join("data");
            let dst = work_data_dir;
            if src.exists() {
                let _ = sync_util::mirror_sync(&src, &dst);
            }
            let _ = std::fs::remove_dir_all(&tmp);
            Ok(sha)
        })();
        let runtime_state = app.state::<Mutex<RuntimeState>>();
        let mut runtime = runtime_state.lock().expect("runtime lock");
        runtime.pull_active = false;
        match result {
            Ok(sha) => {
                let last_pull_at = now_iso_time();
                runtime.last_pull = now_display_time();
                runtime.last_pull_at = last_pull_at.clone();
                let short = sha.chars().take(7).collect::<String>();
                push_log(&mut runtime, &format!("Pull finished ({short})"), "INFO");

                let events = load_calendar_events(&work_root);
                runtime.calendar.last_loaded_at_ms = now_ms();
                if events.is_empty() {
                    runtime.calendar.status = "empty".to_string();
                    runtime.calendar.events = Arc::new(vec![]);
                } else {
                    runtime.calendar.status = "loaded".to_string();
                    runtime.calendar.events = Arc::new(events);
                }

                // Persist last pull.
                drop(runtime);
                let mut cfg = config::load_config();
                let _ = config::set_string(&mut cfg, "last_pull_at", last_pull_at.clone());
                let _ = config::set_string(&mut cfg, "last_pull_sha", sha.clone());
                let _ = config::save_config(&cfg);
            }
            Err(err) => {
                push_log(&mut runtime, &format!("Pull failed: {err}"), "ERROR");
            }
        }
    });
}

#[tauri::command]
pub fn pull_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Value, String> {
    spawn_pull(app, state, "Manual pull started");
    Ok(json!({"ok": true}))
}
