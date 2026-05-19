#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod calendar;
mod commands;
mod config;
mod git_ops;
mod snapshot;
mod startup;
mod state;
mod sync_util;
mod time_util;

use crate::commands::update::default_update_state;
use crate::state::RuntimeState;
use std::sync::Mutex;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconEvent;
use tauri::tray::{MouseButton, MouseButtonState};
use tauri::Manager;
use tauri::WindowEvent;

fn show_main_window(handle: &tauri::AppHandle) {
    let Some(win) = handle.get_webview_window("main") else {
        return;
    };
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(RuntimeState {
            update_state: default_update_state(),
            ..RuntimeState::default()
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::Focused(true) => {
                    // WebView2 can throttle JS while unfocused. When the user returns to the app,
                    // poke the WebView so it can immediately refresh and surface backend-driven
                    // alerts without requiring an extra click.
                    if let Some(webview) = window.get_webview_window(window.label()) {
                        let _ = webview.eval("window.dispatchEvent(new Event('xauusd:wakeup'))");
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    let cfg = config::load_config();
                    let close_behavior = config::get_str(&cfg, "close_behavior");
                    if close_behavior == "tray" {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                WindowEvent::Resized(_) => {
                    let cfg = config::load_config();
                    let close_behavior = config::get_str(&cfg, "close_behavior");
                    if close_behavior != "tray" {
                        return;
                    }
                    if window.is_minimized().unwrap_or(false) {
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::snapshot_cmd::get_snapshot,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::logs::add_log,
            commands::logs::clear_logs,
            commands::settings::set_currency,
            commands::update::get_update_state,
            commands::update::check_updates,
            commands::update::update_now,
            commands::update::install_update,
            commands::pull::pull_now,
            commands::sync::sync_now,
            commands::ui::frontend_boot_complete,
            commands::ui::set_ui_state,
            commands::settings::get_temporary_path_task,
            commands::settings::probe_temporary_path,
            commands::settings::temporary_path_use_as_is,
            commands::settings::temporary_path_reset,
            commands::settings::browse_temporary_path,
            commands::settings::set_temporary_path,
            commands::settings::browse_output_dir,
            commands::settings::set_output_dir,
            commands::open::open_log,
            commands::open::open_path,
            commands::open::open_url,
            commands::open::open_release_notes,
            commands::lifecycle::dismiss_modal,
            commands::history::get_event_history,
            commands::analysis::get_event_impact_usd,
            commands::analysis::get_predict_release_model_usd,
            commands::analysis::get_event_deep_analysis_usd,
            commands::market_agent::get_market_agent_snapshot,
            commands::market_agent::get_market_agent_replay,
            commands::market_agent::get_market_agent_timeline,
            commands::market_agent::get_market_agent_provider_health,
            commands::market_agent::get_market_agent_provider_config,
            commands::market_agent::get_market_agent_telegram_config,
            commands::market_agent::get_market_agent_llm_config,
            commands::market_agent::get_market_agent_driver_attention,
            commands::market_agent::get_market_agent_evidence_for_run,
            commands::market_agent::get_market_agent_state_transitions,
            commands::market_agent::get_market_agent_suppressed_alerts,
            commands::market_agent::save_market_agent_provider_config,
            commands::market_agent::save_market_agent_telegram_config,
            commands::market_agent::save_market_agent_llm_config,
            commands::market_agent::test_market_agent_telegram,
            commands::market_agent::test_market_agent_llm_connection,
            commands::market_agent::test_market_agent_llm_json_response,
            commands::market_agent::test_ctrader_connection,
            commands::market_agent::resolve_ctrader_symbol,
            commands::market_agent::get_ctrader_quote_test,
            commands::market_agent::refresh_ctrader_token,
            commands::market_agent::clear_ctrader_config,
            commands::market_agent::get_market_agent_monitor_status,
            commands::market_agent::run_market_agent_monitor_once,
            commands::market_agent::run_market_agent_backfill_recovery,
            commands::market_agent::start_market_agent_monitor_loop,
            commands::market_agent::stop_market_agent_monitor_loop
        ])
        .setup(|app| {
            let _ = config::maybe_seed_data_from_install();
            let _ = config::ensure_appdata_marker();
            commands::ui::start_background_tasks(app.handle().clone());

            let handle = app.handle();
            // Ensure startup setting is applied (Windows: HKCU Run entry).
            let cfg = config::load_config();
            let run_on_startup = config::get_bool(&cfg, "run_on_startup", true);
            let _ = startup::set_run_on_startup(run_on_startup);

            // If this launch is from OS autostart and launch mode is tray, hide the main window.
            let autostart_launch_mode = config::get_str(&cfg, "autostart_launch_mode");
            let launched_by_autostart = std::env::args().any(|a| a == "--autostart");

            // Build tray menu and handlers (tray icon is created by `tauri.conf.json` trayIcon config).
            let menu = MenuBuilder::new(handle)
                .text("tray:open", "Open")
                .separator()
                .text("tray:exit", "Exit")
                .build()?;

            if let Some(tray) = handle.tray_by_id("main") {
                let _ = tray.set_menu(Some(menu));
            }

            handle.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id == "tray:exit" {
                    app.exit(0);
                    return;
                }
                if id == "tray:open" {
                    show_main_window(app);
                }
            });

            handle.on_tray_icon_event(|app, event| {
                match event {
                    TrayIconEvent::Click {
                        button,
                        button_state,
                        ..
                    } => {
                        if button != MouseButton::Left || button_state != MouseButtonState::Up {
                            return;
                        }
                    }
                    TrayIconEvent::DoubleClick { button, .. } => {
                        if button != MouseButton::Left {
                            return;
                        }
                    }
                    _ => return,
                };
                show_main_window(app);
            });

            if launched_by_autostart && autostart_launch_mode == "tray" {
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
