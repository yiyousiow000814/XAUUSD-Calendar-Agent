use super::*;

#[tauri::command]
pub fn get_snapshot(app: tauri::AppHandle, state: tauri::State<'_, Mutex<RuntimeState>>) -> Value {
    let cfg = config::load_config();
    ensure_calendar_loaded(app.clone(), cfg.clone(), state.clone());

    let (tz_mode, utc_offset_minutes) = get_calendar_settings(&cfg);
    let currency_opts = currency_options();

    // Keep lock scope small to avoid UI stalls (especially when rendering large history lists).
    let (
        currency,
        output_dir,
        repo_path,
        last_pull,
        last_pull_at,
        last_sync,
        last_sync_at,
        logs,
        modal,
        pull_active,
        sync_active,
        calendar_status,
        calendar_events,
    ) = {
        let mut runtime = state.lock().expect("runtime lock");
        if runtime.currency.is_empty() {
            runtime.currency = "USD".to_string();
        }
        if runtime.update_state.is_null() {
            runtime.update_state = super::update::default_update_state();
        }
        if runtime.output_dir.is_empty() {
            runtime.output_dir = config::get_str(&cfg, "output_dir");
        }
        runtime.repo_path = config::install_dir().to_string_lossy().to_string();

        // Hydrate lastPull/lastSync from config so they persist across restarts.
        let last_pull_at_cfg = config::get_str(&cfg, "last_pull_at");
        if !last_pull_at_cfg.is_empty() {
            runtime.last_pull_at = last_pull_at_cfg.to_string();
            if runtime.last_pull.is_empty() {
                if let Some(display) = display_time_from_iso(&last_pull_at_cfg) {
                    runtime.last_pull = display;
                }
            }
        }

        let out = runtime.output_dir.clone();
        let last_sync_at_cfg = cfg
            .get("output_dir_last_sync_at")
            .and_then(|v| v.get(&out))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !last_sync_at_cfg.is_empty() {
            runtime.last_sync_at = last_sync_at_cfg.to_string();
            if runtime.last_sync.is_empty() {
                if let Some(display) = display_time_from_iso(last_sync_at_cfg) {
                    runtime.last_sync = display;
                }
            }
        }

        let last_pull = if runtime.last_pull.is_empty() {
            "Not yet".to_string()
        } else {
            runtime.last_pull.clone()
        };
        let last_sync = if runtime.last_sync.is_empty() {
            "Not yet".to_string()
        } else {
            runtime.last_sync.clone()
        };
        let calendar_status = if runtime.calendar.status.is_empty() {
            "empty".to_string()
        } else {
            runtime.calendar.status.clone()
        };

        (
            runtime.currency.clone(),
            runtime.output_dir.clone(),
            runtime.repo_path.clone(),
            last_pull,
            runtime.last_pull_at.clone(),
            last_sync,
            runtime.last_sync_at.clone(),
            runtime.logs.clone(),
            runtime.modal.clone(),
            runtime.pull_active,
            runtime.sync_active,
            calendar_status,
            runtime.calendar.events.clone(),
        )
    };

    let next_events = render_next_events(
        calendar_events.as_slice(),
        &currency,
        &tz_mode,
        utc_offset_minutes,
        CALENDAR_SOURCE_UTC_OFFSET_MINUTES,
    );
    let past_events = render_past_events(
        calendar_events.as_slice(),
        &currency,
        &tz_mode,
        utc_offset_minutes,
        CALENDAR_SOURCE_UTC_OFFSET_MINUTES,
    );
    let derived_status = if pull_active && calendar_events.is_empty() {
        "downloading".to_string()
    } else {
        calendar_status
    };

    json!({
        "lastPull": last_pull,
        "lastSync": last_sync,
        "lastPullAt": last_pull_at,
        "lastSyncAt": last_sync_at,
        "outputDir": output_dir,
        "repoPath": repo_path,
        "currency": currency,
        "currencyOptions": currency_opts,
        "events": next_events,
        "pastEvents": past_events,
        "logs": logs,
        "version": env!("APP_VERSION"),
        "pullActive": pull_active,
        "syncActive": sync_active,
        "calendarStatus": derived_status,
        "restartInSeconds": 0,
        "modal": if modal.is_null() { Value::Null } else { modal }
    })
}
