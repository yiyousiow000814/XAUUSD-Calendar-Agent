use super::*;

pub(super) enum SpawnSyncStatus {
    Started,
    AlreadyRunning,
}

pub(super) fn spawn_sync(
    app: tauri::AppHandle,
    reason: &str,
    clear_pending_on_start: bool,
) -> SpawnSyncStatus {
    let cfg = config::load_config();
    let output_dir = config::get_str(&cfg, "output_dir");
    let output_dir_key = output_dir.clone();
    {
        let runtime_state = app.state::<Mutex<RuntimeState>>();
        let mut runtime = runtime_state.lock().expect("runtime lock");
        if runtime.sync_active {
            push_log(
                &mut runtime,
                "Sync already running; new sync request ignored",
                "INFO",
            );
            return SpawnSyncStatus::AlreadyRunning;
        }
        if clear_pending_on_start {
            runtime.sync_after_pull_pending = false;
        }
        runtime.sync_active = true;
        push_log(&mut runtime, reason, "INFO");
    }
    tauri::async_runtime::spawn({
        let app = app.clone();
        async move {
            let result = (|| -> Result<sync_util::SyncResult, String> {
                if output_dir.trim().is_empty() {
                    return Err("Output dir not configured".to_string());
                }
                let base_src = config::working_data_dir(&cfg);
                let base_dst = PathBuf::from(output_dir).join("data");

                let mut total = sync_util::SyncResult::default();

                let cal_src = base_src.join("Economic_Calendar");
                let cal_dst = base_dst.join("Economic_Calendar");
                let cal = sync_util::mirror_sync(&cal_src, &cal_dst)?;
                total.copied += cal.copied;
                total.deleted += cal.deleted;
                total.skipped += cal.skipped;

                let hist_src = base_src.join("event_history_index");
                let hist_dst = base_dst.join("event_history_index");
                let hist = sync_util::mirror_sync(&hist_src, &hist_dst)?;
                total.copied += hist.copied;
                total.deleted += hist.deleted;
                total.skipped += hist.skipped;

                Ok(total)
            })();
            let runtime_state = app.state::<Mutex<RuntimeState>>();
            let mut runtime = runtime_state.lock().expect("runtime lock");
            runtime.sync_active = false;
            let mut persist_last_sync_at: Option<String> = None;
            match result {
                Ok(res) => {
                    runtime.last_sync = now_display_time();
                    let last_sync_at = now_iso_time();
                    runtime.last_sync_at = last_sync_at.clone();
                    persist_last_sync_at = Some(last_sync_at);
                    push_log(
                        &mut runtime,
                        &format!(
                            "Sync finished (copied {}, deleted {}, skipped {})",
                            res.copied, res.deleted, res.skipped
                        ),
                        "INFO",
                    );
                }
                Err(err) => {
                    push_log(&mut runtime, &format!("Sync failed: {err}"), "ERROR");
                }
            }
            let rerun_auto_sync = if runtime.sync_after_pull_pending {
                runtime.sync_after_pull_pending = false;
                push_log(
                    &mut runtime,
                    "Auto sync after pull pending -> start queued sync",
                    "INFO",
                );
                true
            } else {
                false
            };
            drop(runtime);
            if let Some(last_sync_at) = persist_last_sync_at {
                // Persist last sync per output dir.
                let mut cfg = config::load_config();
                let _ = config::set_string(&mut cfg, "last_sync_at", last_sync_at.clone());
                set_object_string(
                    &mut cfg,
                    "output_dir_last_sync_at",
                    &output_dir_key,
                    &last_sync_at,
                );
                let _ = config::save_config(&cfg);
            }
            if rerun_auto_sync {
                let _ = spawn_sync(app.clone(), "Auto sync after pull started", true);
            }
        }
    });
    SpawnSyncStatus::Started
}

pub(super) fn request_auto_sync_after_pull(app: tauri::AppHandle) -> SpawnSyncStatus {
    let runtime_state = app.state::<Mutex<RuntimeState>>();
    {
        let mut runtime = runtime_state.lock().expect("runtime lock");
        // Mark pending first so an interleaving manual sync cannot cause this auto-sync request
        // to be dropped between lock release and spawn attempt.
        runtime.sync_after_pull_pending = true;
        if runtime.sync_active {
            push_log(
                &mut runtime,
                "Auto sync after pull queued (sync already running)",
                "INFO",
            );
            return SpawnSyncStatus::AlreadyRunning;
        }
    }
    spawn_sync(app, "Auto sync after pull started", true)
}

#[tauri::command]
pub fn sync_now(
    app: tauri::AppHandle,
    _state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Value, String> {
    match spawn_sync(app, "Manual sync started", false) {
        SpawnSyncStatus::Started => Ok(json!({"ok": true, "started": true})),
        SpawnSyncStatus::AlreadyRunning => {
            Ok(json!({"ok": true, "started": false, "reason": "sync already running"}))
        }
    }
}
