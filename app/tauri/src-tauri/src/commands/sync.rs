use super::*;

#[tauri::command]
pub fn sync_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Value, String> {
    let cfg = config::load_config();
    let output_dir = config::get_str(&cfg, "output_dir");
    let output_dir_key = output_dir.clone();
    {
        let mut runtime = state.lock().expect("runtime lock");
        runtime.sync_active = true;
        push_log(&mut runtime, "Sync started", "INFO");
    }
    tauri::async_runtime::spawn(async move {
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
        match result {
            Ok(res) => {
                runtime.last_sync = now_display_time();
                let last_sync_at = now_iso_time();
                runtime.last_sync_at = last_sync_at.clone();
                push_log(
                    &mut runtime,
                    &format!(
                        "Sync finished (copied {}, deleted {}, skipped {})",
                        res.copied, res.deleted, res.skipped
                    ),
                    "INFO",
                );

                // Persist last sync per output dir.
                drop(runtime);
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
            Err(err) => {
                push_log(&mut runtime, &format!("Sync failed: {err}"), "ERROR");
            }
        }
    });
    Ok(json!({"ok": true}))
}
