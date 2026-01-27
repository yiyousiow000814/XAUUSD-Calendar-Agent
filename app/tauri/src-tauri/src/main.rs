#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod calendar;
mod commands;
mod config;
mod git_ops;
mod snapshot;
mod state;
mod startup;
mod sync_util;
mod time_util;

use crate::commands::default_update_state;
use crate::state::RuntimeState;
use std::sync::Mutex;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconEvent;
use tauri::Manager;
use tauri::WindowEvent;

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(RuntimeState {
            update_state: default_update_state(),
            ..RuntimeState::default()
        }))
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
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
            commands::get_snapshot,
            commands::get_settings,
            commands::save_settings,
            commands::add_log,
            commands::clear_logs,
            commands::set_currency,
            commands::get_update_state,
            commands::check_updates,
            commands::update_now,
            commands::pull_now,
            commands::sync_now,
            commands::frontend_boot_complete,
            commands::set_ui_state,
            commands::get_temporary_path_task,
            commands::probe_temporary_path,
            commands::temporary_path_use_as_is,
            commands::temporary_path_reset,
            commands::browse_temporary_path,
            commands::set_temporary_path,
            commands::browse_output_dir,
            commands::set_output_dir,
            commands::open_log,
            commands::open_path,
            commands::open_url,
            commands::open_release_notes,
            commands::uninstall,
            commands::dismiss_modal,
            commands::get_event_history
        ])
        .setup(|app| {
            commands::start_background_tasks(app.handle().clone());

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
                .text("tray:show", "Show")
                .text("tray:hide", "Hide")
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
                let Some(win) = app.get_webview_window("main") else {
                    return;
                };
                match id {
                    "tray:show" => {
                        let _ = win.show();
                        let _ = win.unminimize();
                        let _ = win.set_focus();
                    }
                    "tray:hide" => {
                        let _ = win.hide();
                    }
                    _ => {}
                }
            });

            handle.on_tray_icon_event(|app, event| {
                match event {
                    TrayIconEvent::Click { .. } | TrayIconEvent::DoubleClick { .. } => {}
                    _ => return,
                }
                let Some(win) = app.get_webview_window("main") else {
                    return;
                };
                let visible = win.is_visible().unwrap_or(true);
                if visible {
                    let _ = win.hide();
                } else {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
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
