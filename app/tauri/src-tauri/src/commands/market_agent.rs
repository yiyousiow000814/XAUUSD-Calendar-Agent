use crate::config;
use chrono::{Datelike, Timelike};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

type LatestMonitorRun = (i64, String, String);
type LatestPayloadRows = (Option<i64>, Option<String>, Vec<Value>);
static CANCEL_OLLAMA_PULL: AtomicBool = AtomicBool::new(false);
const DEFAULT_OLLAMA_ENDPOINT: &str = "http://127.0.0.1:21434";
const DEFAULT_LLM_TEMPERATURE: f64 = 0.0;
const DEFAULT_LLM_TIMEOUT_SECONDS: i64 = 30;
const LEGACY_OLLAMA_ENDPOINT: &str = "http://localhost:11434";
const LIVE_QUOTE_FRESH_AFTER_SECONDS: i64 = 20;
const XAUUSD_WEEKEND_CLOSE_HOUR_UTC: u32 = 22;
const XAUUSD_WEEKEND_REOPEN_HOUR_UTC: u32 = 22;
const MAX_WEEKEND_CONTEXT_AGE_SECONDS: i64 = 96 * 60 * 60;
fn repo_root_from_manifest() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.parent()?.parent()?.parent().map(Path::to_path_buf)
}

fn candidate_roots() -> Vec<PathBuf> {
    let cfg = config::load_config();
    let mut roots = vec![config::working_root_dir(&cfg)];
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.clone());
        roots.push(cwd.join("user-data"));
    }
    if let Some(repo_root) = repo_root_from_manifest() {
        roots.push(repo_root.clone());
        roots.push(repo_root.join("user-data"));
    }
    roots.push(config::install_dir());
    roots.push(config::install_dir().join("user-data"));
    roots.push(config::appdata_dir());
    let mut unique = vec![];
    for root in roots {
        if !unique.iter().any(|existing: &PathBuf| existing == &root) {
            unique.push(root);
        }
    }
    unique
}

fn state_path_for_root(root: &Path) -> PathBuf {
    root.join("market_agent_state.json")
}

fn alerts_path_for_root(root: &Path) -> PathBuf {
    root.join("market_agent_alerts.ndjson")
}

fn timeline_path_for_root(root: &Path) -> PathBuf {
    root.join("market_agent_timeline.sqlite")
}

fn monitor_status_path_for_root(root: &Path) -> PathBuf {
    root.join("market_agent_monitor_status.json")
}

fn monitor_lock_path_for_root(root: &Path) -> PathBuf {
    root.join("market_agent_monitor.lock")
}

fn live_quote_snapshot_path_for_root(root: &Path) -> PathBuf {
    root.join("ctrader-live-quote.json")
}

fn live_quote_stream_status_path_for_root(root: &Path) -> PathBuf {
    root.join("ctrader_live_stream_status.json")
}

fn ctrader_config_path_for_root(root: &Path) -> PathBuf {
    root.join("ctrader-cli.json")
}

fn telegram_config_path_for_root(root: &Path) -> PathBuf {
    root.join("market-agent-telegram.json")
}

fn llm_config_path_for_root(root: &Path) -> PathBuf {
    root.join("market-agent-llm.json")
}

fn local_ai_models_dir() -> PathBuf {
    config::appdata_dir().join("local-ai").join("models")
}

fn read_json_object(path: &Path) -> serde_json::Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn read_fallback_json_object(
    primary_path: &Path,
    candidate: impl Fn(&Path) -> PathBuf,
) -> serde_json::Map<String, Value> {
    let primary = read_json_object(primary_path);
    if !primary.is_empty() {
        return primary;
    }
    for root in candidate_roots() {
        let path = candidate(&root);
        if path == primary_path {
            continue;
        }
        let fallback = read_json_object(&path);
        if !fallback.is_empty() {
            return fallback;
        }
    }
    serde_json::Map::new()
}

fn spawn_debug_log_path(root: &Path) -> PathBuf {
    root.join("market_agent_spawn_debug.ndjson")
}

fn append_spawn_debug(root: &Path, payload: Value) {
    let path = spawn_debug_log_path(root);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut line = match serde_json::to_string(&payload) {
        Ok(line) => line,
        Err(_) => return,
    };
    line.push('\n');
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(line.as_bytes()));
}

fn market_agent_log_root() -> PathBuf {
    resolve_market_agent_root().unwrap_or_else(config::appdata_dir)
}

fn market_agent_runtime_root() -> PathBuf {
    resolve_market_agent_root().unwrap_or_else(config::appdata_dir)
}

fn market_agent_debug_payload(payload: &Value) -> Value {
    match payload {
        Value::Object(map) => {
            let mut sanitized = serde_json::Map::new();
            for key in [
                "limit",
                "start",
                "end",
                "monitorRunId",
                "monitor_run_id",
                "intervalSeconds",
                "includeActivity",
            ] {
                if let Some(value) = map.get(key) {
                    sanitized.insert(key.to_string(), value.clone());
                }
            }
            Value::Object(sanitized)
        }
        _ => Value::Null,
    }
}

fn run_logged_market_agent_command<F>(command: &str, payload: &Value, work: F) -> Value
where
    F: FnOnce() -> Value,
{
    let root = market_agent_log_root();
    append_spawn_debug(
        &root,
        json!({
            "ts": chrono::Utc::now().to_rfc3339(),
            "event": "command_start",
            "layer": "market_agent_command",
            "command": command,
            "payload": market_agent_debug_payload(payload),
        }),
    );
    let started = Instant::now();
    let result = work();
    append_spawn_debug(
        &root,
        json!({
            "ts": chrono::Utc::now().to_rfc3339(),
            "event": "command_result",
            "layer": "market_agent_command",
            "command": command,
            "elapsed_ms": started.elapsed().as_millis() as u64,
            "ok": result.get("ok").and_then(Value::as_bool),
            "available": result.get("available").and_then(Value::as_bool),
            "message": result.get("message").and_then(Value::as_str),
        }),
    );
    result
}

fn run_market_agent_command<F>(work: F) -> Value
where
    F: FnOnce() -> Value,
{
    work()
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let payload = serde_json::to_string_pretty(value).map_err(|err| err.to_string())?;
    fs::write(&temp, payload).map_err(|err| err.to_string())?;
    fs::rename(&temp, path).map_err(|err| err.to_string())?;
    Ok(())
}

fn mask_secret(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 4 {
        return "*".repeat(chars.len());
    }
    let prefix: String = chars.iter().take(2).collect();
    let suffix: String = chars.iter().skip(chars.len().saturating_sub(2)).collect();
    format!(
        "{}{}{}",
        prefix,
        "*".repeat(std::cmp::max(4, chars.len().saturating_sub(4))),
        suffix
    )
}

fn merged_ctrader_provider_config(root: &Path, override_payload: Option<&Value>) -> Value {
    let config_path = ctrader_config_path_for_root(root);
    let config_payload = read_fallback_json_object(&config_path, ctrader_config_path_for_root);
    let input = override_payload
        .and_then(|payload| payload.get("ctrader"))
        .or(override_payload)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let get_str = |key: &str| -> String {
        input
            .get(key)
            .and_then(Value::as_str)
            .or_else(|| config_payload.get(key).and_then(Value::as_str))
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let get_secret_str = |key: &str| -> String {
        input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                config_payload
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
            })
            .unwrap_or("")
            .to_string()
    };
    let get_bool = |key: &str, fallback: bool| -> bool {
        input
            .get(key)
            .and_then(Value::as_bool)
            .or_else(|| config_payload.get(key).and_then(Value::as_bool))
            .unwrap_or(fallback)
    };
    let get_i64 = |key: &str| -> Option<i64> {
        input
            .get(key)
            .and_then(Value::as_i64)
            .or_else(|| config_payload.get(key).and_then(Value::as_i64))
    };
    let environment = {
        let env = get_str("environment");
        if env.eq_ignore_ascii_case("live") {
            "live".to_string()
        } else {
            "demo".to_string()
        }
    };
    let symbol = {
        let value = get_str("symbol");
        if value.is_empty() {
            "XAUUSD".to_string()
        } else {
            value
        }
    };
    let snapshot_path = input
        .get("snapshotPath")
        .and_then(Value::as_str)
        .or_else(|| config_payload.get("snapshotPath").and_then(Value::as_str))
        .map(String::from)
        .unwrap_or_else(|| root.join("ctrader-live-quote.json").display().to_string());
    let cli_executable = {
        let value = get_str("cliExecutable");
        if value.is_empty() {
            "ctrader-cli".to_string()
        } else {
            value
        }
    };
    json!({
        "enabled": get_bool("enabled", false),
        "accountId": get_str("accountId"),
        "ctid": get_secret_str("ctid"),
        "password": get_secret_str("password"),
        "environment": environment,
        "symbol": symbol,
        "symbolId": get_i64("symbolId"),
        "snapshotPath": snapshot_path,
        "quoteTimeoutSeconds": get_i64("quoteTimeoutSeconds").unwrap_or(8),
        "quoteStaleAfterSeconds": get_i64("quoteStaleAfterSeconds").unwrap_or(15),
        "allowSavedSnapshotFallback": get_bool("allowSavedSnapshotFallback", false),
        "cliExecutable": cli_executable,
        "configPath": config_path.display().to_string(),
    })
}

fn masked_ctrader_provider_config(root: &Path) -> Value {
    let merged = merged_ctrader_provider_config(root, None);
    json!({
        "ok": true,
        "available": true,
        "ctrader": {
            "enabled": merged.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            "environment": merged.get("environment").and_then(Value::as_str).unwrap_or("demo"),
            "symbol": merged.get("symbol").and_then(Value::as_str).unwrap_or("XAUUSD"),
            "symbolId": merged.get("symbolId").cloned().unwrap_or(Value::Null),
            "accountId": merged.get("accountId").and_then(Value::as_str).unwrap_or(""),
            "ctidMasked": mask_secret(merged.get("ctid").and_then(Value::as_str).unwrap_or("")),
            "passwordMasked": mask_secret(merged.get("password").and_then(Value::as_str).unwrap_or("")),
            "hasPassword": !merged.get("password").and_then(Value::as_str).unwrap_or("").trim().is_empty(),
            "snapshotPath": merged.get("snapshotPath").and_then(Value::as_str).unwrap_or(""),
            "quoteTimeoutSeconds": merged.get("quoteTimeoutSeconds").and_then(Value::as_i64).unwrap_or(8),
            "quoteStaleAfterSeconds": merged.get("quoteStaleAfterSeconds").and_then(Value::as_i64).unwrap_or(15),
            "allowSavedSnapshotFallback": merged.get("allowSavedSnapshotFallback").and_then(Value::as_bool).unwrap_or(false),
            "configPath": merged.get("configPath").and_then(Value::as_str).unwrap_or(""),
        }
    })
}

fn save_ctrader_provider_config(root: &Path, payload: &Value) -> Result<Value, String> {
    let merged = merged_ctrader_provider_config(root, Some(payload));
    let config_path = ctrader_config_path_for_root(root);
    let config_payload = json!({
        "enabled": merged.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "accountId": merged.get("accountId").and_then(Value::as_str).unwrap_or(""),
        "ctid": merged.get("ctid").and_then(Value::as_str).unwrap_or(""),
        "password": merged.get("password").and_then(Value::as_str).unwrap_or(""),
        "environment": merged.get("environment").and_then(Value::as_str).unwrap_or("demo"),
        "symbol": merged.get("symbol").and_then(Value::as_str).unwrap_or("XAUUSD"),
        "symbolId": merged.get("symbolId").cloned().unwrap_or(Value::Null),
        "snapshotPath": merged.get("snapshotPath").and_then(Value::as_str).unwrap_or(""),
        "quoteTimeoutSeconds": merged.get("quoteTimeoutSeconds").and_then(Value::as_i64).unwrap_or(8),
        "quoteStaleAfterSeconds": merged.get("quoteStaleAfterSeconds").and_then(Value::as_i64).unwrap_or(15),
        "allowSavedSnapshotFallback": merged.get("allowSavedSnapshotFallback").and_then(Value::as_bool).unwrap_or(false),
        "cliExecutable": merged.get("cliExecutable").and_then(Value::as_str).unwrap_or("ctrader-cli"),
    });
    write_json_atomic(&config_path, &config_payload)?;
    Ok(masked_ctrader_provider_config(root))
}

fn array_or_csv(value: Option<&Value>, fallback: &[&str]) -> Vec<String> {
    if let Some(Value::Array(items)) = value {
        let parsed: Vec<String> = items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect();
        if !parsed.is_empty() {
            return parsed;
        }
    }
    if let Some(raw) = value.and_then(Value::as_str) {
        let parsed: Vec<String> = raw
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect();
        if !parsed.is_empty() {
            return parsed;
        }
    }
    fallback.iter().map(|item| item.to_string()).collect()
}

fn merged_telegram_config_for_root(root: &Path, override_payload: Option<&Value>) -> Value {
    let config_path = telegram_config_path_for_root(root);
    let config_payload = read_json_object(&config_path);
    let input = override_payload
        .and_then(|payload| payload.get("telegram"))
        .or(override_payload)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let get_str = |key: &str| -> String {
        input
            .get(key)
            .and_then(Value::as_str)
            .or_else(|| config_payload.get(key).and_then(Value::as_str))
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let get_secret_str = |key: &str| -> String {
        input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                config_payload
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
            })
            .unwrap_or("")
            .to_string()
    };
    let get_bool = |key: &str, fallback: bool| -> bool {
        input
            .get(key)
            .and_then(Value::as_bool)
            .or_else(|| config_payload.get(key).and_then(Value::as_bool))
            .unwrap_or(fallback)
    };
    let get_i64 = |key: &str, fallback: i64| -> i64 {
        input
            .get(key)
            .and_then(Value::as_i64)
            .or_else(|| config_payload.get(key).and_then(Value::as_i64))
            .unwrap_or(fallback)
    };
    let levels = array_or_csv(
        input.get("levels").or_else(|| config_payload.get("levels")),
        &["level_2", "level_3"],
    );
    json!({
        "enabled": get_bool("enabled", false),
        "botToken": get_secret_str("botToken"),
        "chatId": get_str("chatId"),
        "timeoutSeconds": get_i64("timeoutSeconds", 10),
        "levels": levels,
        "configPath": config_path.display().to_string(),
        "lastSendStatus": get_str("lastSendStatus"),
        "lastError": get_str("lastError"),
    })
}

fn masked_telegram_config_for_root(root: &Path) -> Value {
    let merged = merged_telegram_config_for_root(root, None);
    json!({
        "ok": true,
        "available": true,
        "telegram": {
            "enabled": merged.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            "botTokenMasked": mask_secret(merged.get("botToken").and_then(Value::as_str).unwrap_or("")),
            "hasBotToken": !merged.get("botToken").and_then(Value::as_str).unwrap_or("").trim().is_empty(),
            "chatId": merged.get("chatId").and_then(Value::as_str).unwrap_or(""),
            "timeoutSeconds": merged.get("timeoutSeconds").and_then(Value::as_i64).unwrap_or(10),
            "levels": merged.get("levels").cloned().unwrap_or_else(|| json!(["level_2", "level_3"])),
            "configPath": merged.get("configPath").and_then(Value::as_str).unwrap_or(""),
            "lastSendStatus": merged.get("lastSendStatus").and_then(Value::as_str).unwrap_or("not tested"),
            "lastError": merged.get("lastError").and_then(Value::as_str).unwrap_or(""),
        }
    })
}

fn save_telegram_config_for_root(root: &Path, payload: &Value) -> Result<Value, String> {
    let merged = merged_telegram_config_for_root(root, Some(payload));
    write_json_atomic(&telegram_config_path_for_root(root), &merged)?;
    Ok(masked_telegram_config_for_root(root))
}

fn merged_llm_config_for_root(root: &Path, override_payload: Option<&Value>) -> Value {
    let config_path = llm_config_path_for_root(root);
    let config_payload = read_json_object(&config_path);
    let input = override_payload
        .and_then(|payload| payload.get("llm"))
        .or(override_payload)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let get_str = |key: &str, fallback: &str| -> String {
        input
            .get(key)
            .and_then(Value::as_str)
            .or_else(|| config_payload.get(key).and_then(Value::as_str))
            .unwrap_or(fallback)
            .trim()
            .to_string()
    };
    let get_bool = |key: &str, fallback: bool| -> bool {
        input
            .get(key)
            .and_then(Value::as_bool)
            .or_else(|| config_payload.get(key).and_then(Value::as_bool))
            .unwrap_or(fallback)
    };
    let get_i64 = |key: &str, fallback: i64| -> i64 {
        input
            .get(key)
            .and_then(Value::as_i64)
            .or_else(|| config_payload.get(key).and_then(Value::as_i64))
            .unwrap_or(fallback)
    };
    let get_f64 = |key: &str, fallback: f64| -> f64 {
        input
            .get(key)
            .and_then(Value::as_f64)
            .or_else(|| config_payload.get(key).and_then(Value::as_f64))
            .unwrap_or(fallback)
    };
    json!({
        "enabled": get_bool("enabled", false),
        "provider": get_str("provider", "ollama"),
        "endpoint": normalize_local_ai_endpoint(&get_str("endpoint", DEFAULT_OLLAMA_ENDPOINT)),
        "model": get_str("model", "qwen3.5:4b"),
        "temperature": get_f64("temperature", DEFAULT_LLM_TEMPERATURE),
        "timeoutSeconds": get_i64("timeoutSeconds", DEFAULT_LLM_TIMEOUT_SECONDS),
        "keepAlive": get_str("keepAlive", "0"),
        "maxContext": get_i64("maxContext", 8192),
        "configPath": config_path.display().to_string(),
        "lastStatus": get_str("lastStatus", "disabled"),
        "lastError": get_str("lastError", ""),
    })
}

fn masked_llm_config_for_root(root: &Path) -> Value {
    let merged = merged_llm_config_for_root(root, None);
    json!({
        "ok": true,
        "available": true,
        "llm": {
            "enabled": merged.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            "provider": merged.get("provider").and_then(Value::as_str).unwrap_or("ollama"),
            "endpoint": normalize_local_ai_endpoint(
                merged
                    .get("endpoint")
                    .and_then(Value::as_str)
                    .unwrap_or(DEFAULT_OLLAMA_ENDPOINT),
            ),
            "model": merged.get("model").and_then(Value::as_str).unwrap_or("qwen3.5:4b"),
            "temperature": merged.get("temperature").and_then(Value::as_f64).unwrap_or(DEFAULT_LLM_TEMPERATURE),
            "timeoutSeconds": merged.get("timeoutSeconds").and_then(Value::as_i64).unwrap_or(DEFAULT_LLM_TIMEOUT_SECONDS),
            "keepAlive": merged.get("keepAlive").and_then(Value::as_str).unwrap_or("0"),
            "maxContext": merged.get("maxContext").and_then(Value::as_i64).unwrap_or(8192),
            "configPath": merged.get("configPath").and_then(Value::as_str).unwrap_or(""),
            "lastStatus": merged.get("lastStatus").and_then(Value::as_str).unwrap_or("disabled"),
            "lastError": merged.get("lastError").and_then(Value::as_str).unwrap_or(""),
        }
    })
}

fn save_llm_config_for_root(root: &Path, payload: &Value) -> Result<Value, String> {
    let merged = merged_llm_config_for_root(root, Some(payload));
    write_json_atomic(&llm_config_path_for_root(root), &merged)?;
    Ok(masked_llm_config_for_root(root))
}

fn llm_env_for_root(root: &Path) -> HashMap<String, String> {
    let merged = merged_llm_config_for_root(root, None);
    let mut env = HashMap::new();
    env.insert(
        "LOCAL_LLM_ENABLED".to_string(),
        if merged
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "true".to_string()
        } else {
            "false".to_string()
        },
    );
    env.insert(
        "LOCAL_LLM_PROVIDER".to_string(),
        merged
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("ollama")
            .to_string(),
    );
    env.insert(
        "LOCAL_LLM_ENDPOINT".to_string(),
        normalize_local_ai_endpoint(
            merged
                .get("endpoint")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_OLLAMA_ENDPOINT),
        ),
    );
    env.insert(
        "LOCAL_LLM_MODEL".to_string(),
        merged
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("qwen3.5:4b")
            .to_string(),
    );
    env.insert(
        "LOCAL_LLM_TEMPERATURE".to_string(),
        merged
            .get("temperature")
            .and_then(Value::as_f64)
            .unwrap_or(DEFAULT_LLM_TEMPERATURE)
            .to_string(),
    );
    env.insert(
        "LOCAL_LLM_TIMEOUT_SECONDS".to_string(),
        merged
            .get("timeoutSeconds")
            .and_then(Value::as_i64)
            .unwrap_or(DEFAULT_LLM_TIMEOUT_SECONDS)
            .to_string(),
    );
    env.insert(
        "LOCAL_LLM_KEEP_ALIVE".to_string(),
        merged
            .get("keepAlive")
            .and_then(Value::as_str)
            .unwrap_or("0")
            .to_string(),
    );
    env.insert(
        "LOCAL_LLM_MAX_CONTEXT".to_string(),
        merged
            .get("maxContext")
            .and_then(Value::as_i64)
            .unwrap_or(8192)
            .to_string(),
    );
    env
}

fn gib(value: i64) -> f64 {
    value as f64 / 1_073_741_824.0
}

fn model_profile(name: &str) -> Value {
    match name {
        "qwen3.5:4b" => json!({
            "name": "qwen3.5:4b",
            "tier": "balanced",
            "label": "Balanced",
            "approximateSizeBytes": 2_900_000_000_i64,
            "diskLabel": "~2.9 GB",
            "reason": "Fast local JSON explanations on NVIDIA GPUs with 8GB VRAM or better."
        }),
        "qwen3.5:2b" => json!({
            "name": "qwen3.5:2b",
            "tier": "middle",
            "label": "Middle fallback",
            "approximateSizeBytes": 1_600_000_000_i64,
            "diskLabel": "~1.6 GB",
            "reason": "Lower VRAM or fallback when 4B JSON/latency is unstable."
        }),
        "qwen3.5:0.8b" => json!({
            "name": "qwen3.5:0.8b",
            "tier": "lightweight",
            "label": "Lightweight",
            "approximateSizeBytes": 650_000_000_i64,
            "diskLabel": "~650 MB",
            "reason": "CPU-only, weak laptop, or low memory setup."
        }),
        _ => json!({
            "name": "rule-based-only",
            "tier": "rule_based",
            "label": "Rule-based only",
            "approximateSizeBytes": 0,
            "diskLabel": "0 GB",
            "reason": "LLM unavailable or unsuitable. Rule-based evidence remains active."
        }),
    }
}

fn local_model_profiles() -> Vec<Value> {
    vec![
        model_profile("qwen3.5:4b"),
        model_profile("qwen3.5:2b"),
        model_profile("qwen3.5:0.8b"),
        model_profile("rule-based-only"),
    ]
}

fn model_name(value: &Value) -> &str {
    value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("rule-based-only")
}

fn recommend_local_model_from_profile(profile: &Value) -> Value {
    let gpu_name = profile
        .get("gpuName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let gpu_vendor = profile
        .get("gpuVendor")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let nvidia_available = profile
        .get("nvidiaAvailable")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || gpu_vendor.contains("nvidia")
        || gpu_name.contains("nvidia")
        || gpu_name.contains("rtx");
    let vram_bytes = profile
        .get("vramBytes")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let ram_bytes = profile.get("ramBytes").and_then(Value::as_i64).unwrap_or(0);
    let is_known_balanced_card = gpu_name.contains("rtx 3060")
        || gpu_name.contains("rtx3060")
        || gpu_name.contains("rtx 3090")
        || gpu_name.contains("rtx3090");

    let mut profile = if nvidia_available && (vram_bytes >= 8_000_000_000 || is_known_balanced_card)
    {
        model_profile("qwen3.5:4b")
    } else if nvidia_available && vram_bytes >= 4_000_000_000 {
        model_profile("qwen3.5:2b")
    } else if ram_bytes > 0 && gib(ram_bytes) < 8.0 {
        model_profile("rule-based-only")
    } else {
        model_profile("qwen3.5:0.8b")
    };

    let selected_model = model_name(&profile).to_string();
    if let Some(obj) = profile.as_object_mut() {
        let reason = if selected_model == "qwen3.5:4b" && gpu_name.contains("3090") {
            "RTX 3090 defaults to qwen3.5:4b because this app needs fast reliable JSON, not heavy slow reasoning."
        } else if selected_model == "qwen3.5:4b" {
            "NVIDIA GPU with 8GB VRAM or better can use the balanced model for fast JSON."
        } else if selected_model == "qwen3.5:2b" {
            "Lower VRAM detected, so the middle fallback is safer."
        } else if selected_model == "qwen3.5:0.8b" {
            "CPU-only or weak machine detected, so the lightweight model is safer."
        } else {
            "Machine memory is too limited for reliable local LLM setup."
        };
        obj.insert("reason".to_string(), Value::String(reason.to_string()));
    }
    profile
}

fn next_local_model_name(current_model: &str) -> Option<&'static str> {
    match current_model {
        "qwen3.5:4b" => Some("qwen3.5:2b"),
        "qwen3.5:2b" => Some("qwen3.5:0.8b"),
        "qwen3.5:0.8b" => None,
        _ => Some("qwen3.5:0.8b"),
    }
}

fn apply_llm_fallback_policy_for_result(
    current_model: &str,
    status: &str,
    elapsed_ms: Option<i64>,
) -> Value {
    let failed = matches!(
        status,
        "invalid_json" | "model_too_slow" | "unavailable" | "timeout" | "failed"
    ) || elapsed_ms.map(|value| value > 8_000).unwrap_or(false);
    if !failed {
        return json!({
            "ok": true,
            "status": "model_ready",
            "model": current_model,
            "ruleBasedActive": true,
            "message": "Model passed JSON and benchmark checks."
        });
    }
    if let Some(next) = next_local_model_name(current_model) {
        return json!({
            "ok": true,
            "status": "fallback_active",
            "model": next,
            "fromModel": current_model,
            "reason": status,
            "ruleBasedActive": true,
            "message": format!("Using fallback model {next}. Rule-based evidence remains active.")
        });
    }
    json!({
        "ok": true,
        "status": "llm_disabled",
        "model": "rule-based-only",
        "fromModel": current_model,
        "reason": status,
        "ruleBasedActive": true,
        "message": "All local LLM options failed. Rule-based analysis stays active."
    })
}

fn detect_system_profile_value() -> Value {
    let logical_cpu_count = std::thread::available_parallelism()
        .map(|value| value.get() as i64)
        .unwrap_or(0);
    let cpu = std::env::var("PROCESSOR_IDENTIFIER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Unknown CPU".to_string())
        .trim()
        .to_string();
    let ram_bytes = 0;
    let gpu_name = String::new();
    let vram_bytes = 0;
    let lower_gpu = gpu_name.to_lowercase();
    let gpu_vendor = if lower_gpu.contains("nvidia") || lower_gpu.contains("rtx") {
        "NVIDIA"
    } else if lower_gpu.contains("amd") || lower_gpu.contains("radeon") {
        "AMD"
    } else if lower_gpu.contains("intel") {
        "Intel"
    } else {
        ""
    };
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "cpu": cpu,
        "logicalCpuCount": logical_cpu_count,
        "ramBytes": ram_bytes,
        "gpuVendor": gpu_vendor,
        "gpuName": gpu_name,
        "vramBytes": vram_bytes,
        "nvidiaAvailable": gpu_vendor == "NVIDIA",
        "profileMode": "safe_no_shell",
    })
}

fn endpoint_from_payload(payload: &Value) -> String {
    let endpoint = payload
        .get("endpoint")
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("llm")
                .and_then(|value| value.get("endpoint"))
                .and_then(Value::as_str)
        })
        .unwrap_or(DEFAULT_OLLAMA_ENDPOINT)
        .trim()
        .trim_end_matches('/')
        .to_string();
    normalize_local_ai_endpoint(&endpoint)
}

fn normalize_local_ai_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case(LEGACY_OLLAMA_ENDPOINT)
        || trimmed.eq_ignore_ascii_case("http://127.0.0.1:11434")
    {
        return DEFAULT_OLLAMA_ENDPOINT.to_string();
    }
    trimmed.to_string()
}

fn model_from_payload(payload: &Value) -> String {
    payload
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("llm")
                .and_then(|value| value.get("model"))
                .and_then(Value::as_str)
        })
        .unwrap_or("qwen3.5:4b")
        .trim()
        .to_string()
}

fn find_ollama_executable_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("Ollama")
                .join(if cfg!(target_os = "windows") {
                    "ollama.exe"
                } else {
                    "ollama"
                }),
        );
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("Ollama").join(
            if cfg!(target_os = "windows") {
                "ollama.exe"
            } else {
                "ollama"
            },
        ));
    }
    if let Ok(path_var) = std::env::var("PATH") {
        let executable = if cfg!(target_os = "windows") {
            "ollama.exe"
        } else {
            "ollama"
        };
        for entry in std::env::split_paths(&path_var) {
            candidates.push(entry.join(executable));
            if cfg!(target_os = "windows") {
                candidates.push(entry.join("ollama"));
            }
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn check_ollama_installed_value() -> Value {
    match find_ollama_executable_path() {
        Some(path) => json!({
            "ok": true,
            "installed": true,
            "status": "installed",
            "version": "",
            "path": path.display().to_string(),
            "message": "Local AI runtime is installed."
        }),
        None => json!({
            "ok": false,
            "installed": false,
            "status": "runtime_missing",
            "version": "",
            "message": "Local AI runtime is not installed yet. It will be prepared automatically when needed."
        }),
    }
}

fn check_ollama_running_value(endpoint: &str) -> Value {
    let url = format!("{}/api/version", endpoint.trim_end_matches('/'));
    match ureq::get(&url).timeout(Duration::from_secs(3)).call() {
        Ok(response) => {
            let payload = response.into_json::<Value>().unwrap_or_else(|_| json!({}));
            json!({
                "ok": true,
                "running": true,
                "endpointReachable": true,
                "status": "runtime_ready",
                "endpoint": endpoint,
                "version": payload.get("version").and_then(Value::as_str).unwrap_or(""),
                "message": "Local AI runtime is reachable."
            })
        }
        Err(err) => json!({
            "ok": false,
            "running": false,
            "endpointReachable": false,
            "status": "runtime_starting",
            "endpoint": endpoint,
            "error": err.to_string(),
            "message": "Local AI runtime is preparing."
        }),
    }
}

fn background_command(program: &str) -> Command {
    let mut command = Command::new(program);
    hide_child_window(&mut command);
    command
}

fn ollama_host_from_endpoint(endpoint: &str) -> String {
    normalize_local_ai_endpoint(endpoint)
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string()
}

fn spawn_ollama_serve(endpoint: &str) -> Result<(), String> {
    let models_dir = local_ai_models_dir();
    let _ = fs::create_dir_all(&models_dir);
    let executable = find_ollama_executable_path()
        .ok_or_else(|| "Ollama executable was not found.".to_string())?;
    background_command(&executable.display().to_string())
        .arg("serve")
        .env("OLLAMA_HOST", ollama_host_from_endpoint(endpoint))
        .env("OLLAMA_MODELS", models_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "windows")]
fn spawn_ollama_installer() -> Result<(), String> {
    background_command("winget")
        .args([
            "install",
            "--id",
            "Ollama.Ollama",
            "-e",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(not(target_os = "windows"))]
fn spawn_ollama_installer() -> Result<(), String> {
    Err("Automatic runtime installation is not available on this platform.".to_string())
}

fn wait_for_ollama_runtime(endpoint: &str, timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        if is_ollama_pull_cancelled() {
            return json!({
                "ok": false,
                "running": false,
                "endpointReachable": false,
                "status": "cancelled",
                "endpoint": endpoint,
                "message": "Model download cancelled."
            });
        }
        let running = check_ollama_running_value(endpoint);
        if running
            .get("running")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return running;
        }
        if Instant::now() >= deadline {
            return running;
        }
        std::thread::sleep(Duration::from_millis(700));
    }
}

fn prepare_ollama_runtime(endpoint: &str) -> Value {
    if is_ollama_pull_cancelled() {
        return json!({
            "ok": false,
            "running": false,
            "endpointReachable": false,
            "status": "cancelled",
            "endpoint": endpoint,
            "message": "Model download cancelled."
        });
    }
    let running = check_ollama_running_value(endpoint);
    if running
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return running;
    }

    let installed = check_ollama_installed_value();
    if installed
        .get("installed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        match spawn_ollama_serve(endpoint) {
            Ok(()) => {
                let after_start = wait_for_ollama_runtime(endpoint, Duration::from_secs(18));
                if after_start
                    .get("running")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return after_start;
                }
                return json!({
                    "ok": false,
                    "running": false,
                    "endpointReachable": false,
                    "status": "runtime_starting",
                    "endpoint": endpoint,
                    "message": "Local AI runtime is still preparing in the background.",
                    "error": after_start.get("error").and_then(Value::as_str).unwrap_or("")
                });
            }
            Err(err) => {
                return json!({
                    "ok": false,
                    "running": false,
                    "endpointReachable": false,
                    "status": "runtime_starting",
                    "endpoint": endpoint,
                    "message": "Local AI runtime is still preparing in the background.",
                    "error": err
                });
            }
        }
    }

    let installer_result = spawn_ollama_installer();
    json!({
        "ok": false,
        "running": false,
        "endpointReachable": false,
        "status": "runtime_installing",
        "endpoint": endpoint,
        "message": "Local AI runtime is being prepared in the background. Rule-based analysis remains active.",
        "error": installer_result.err().unwrap_or_default()
    })
}

fn list_ollama_models_value(endpoint: &str) -> Value {
    let url = format!("{}/api/tags", endpoint.trim_end_matches('/'));
    match ureq::get(&url).timeout(Duration::from_secs(5)).call() {
        Ok(response) => {
            let payload = response.into_json::<Value>().unwrap_or_else(|_| json!({}));
            let models = payload
                .get("models")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let names: Vec<Value> = models
                .iter()
                .filter_map(|item| {
                    item.get("name")
                        .or_else(|| item.get("model"))
                        .and_then(Value::as_str)
                        .map(|name| Value::String(name.to_string()))
                })
                .collect();
            json!({
                "ok": true,
                "status": "models_ready",
                "endpoint": endpoint,
                "models": models,
                "modelNames": names
            })
        }
        Err(err) => json!({
            "ok": false,
            "status": "runtime_starting",
            "endpoint": endpoint,
            "models": [],
            "modelNames": [],
            "error": err.to_string(),
        }),
    }
}

fn local_ai_model_name_from_manifest(path: &Path) -> Option<String> {
    let tag = path.file_name()?.to_string_lossy();
    let family = path.parent()?.file_name()?.to_string_lossy();
    if family.is_empty() || tag.is_empty() {
        return None;
    }
    Some(format!("{family}:{tag}"))
}

fn list_local_ai_model_files() -> Vec<Value> {
    let manifests_root = local_ai_models_dir()
        .join("manifests")
        .join("registry.ollama.ai")
        .join("library");
    let mut pending = vec![manifests_root];
    let mut models = vec![];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let Some(name) = local_ai_model_name_from_manifest(&path) else {
                continue;
            };
            let size = fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|payload| payload.get("layers").and_then(Value::as_array).cloned())
                .map(|layers| {
                    layers
                        .iter()
                        .filter_map(|layer| layer.get("size").and_then(Value::as_i64))
                        .sum::<i64>()
                })
                .unwrap_or(0);
            models.push(json!({
                "name": name,
                "model": name,
                "size": size,
                "source": "app_local_models",
            }));
        }
    }
    models.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(right.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    models
}

fn merge_local_ai_model_lists(
    mut runtime_models: Vec<Value>,
    local_models: Vec<Value>,
) -> Vec<Value> {
    for local_model in local_models {
        let local_name = local_model
            .get("name")
            .or_else(|| local_model.get("model"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let exists = runtime_models.iter().any(|runtime_model| {
            runtime_model
                .get("name")
                .or_else(|| runtime_model.get("model"))
                .and_then(Value::as_str)
                .unwrap_or("")
                == local_name
        });
        if !exists {
            runtime_models.push(local_model);
        }
    }
    runtime_models
}

fn detect_local_ai_setup_value(root: &Path, payload: &Value) -> Value {
    let profile = payload
        .get("system")
        .or_else(|| payload.get("profile"))
        .cloned()
        .unwrap_or_else(detect_system_profile_value);
    let endpoint = endpoint_from_payload(payload);
    let installed = check_ollama_installed_value();
    let recommended = recommend_local_model_from_profile(&profile);
    let fallback_chain = json!([
        "qwen3.5:4b",
        "qwen3.5:2b",
        "qwen3.5:0.8b",
        "rule-based-only"
    ]);
    if !installed
        .get("installed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "ok": true,
            "available": true,
            "status": "runtime_missing",
            "message": "Local AI runtime is not installed yet. Downloading a model will prepare it automatically.",
            "system": profile,
            "ollama": {
                "installed": false,
                "running": false,
                "endpointReachable": false,
                "endpoint": endpoint
            },
            "installedModels": [],
            "recommendedModel": recommended,
            "profiles": local_model_profiles(),
            "fallbackChain": fallback_chain,
            "ruleBasedActive": true,
            "llm": masked_llm_config_for_root(root).get("llm").cloned().unwrap_or(Value::Null),
        });
    }
    let running = check_ollama_running_value(&endpoint);
    if !running
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let local_models = list_local_ai_model_files();
        return json!({
            "ok": true,
            "available": true,
            "status": "runtime_not_running",
            "message": "Local AI runtime is installed but not running yet. Starting Local AI will use an installed model when one is present.",
            "system": profile,
            "ollama": {
                "installed": true,
                "running": false,
                "endpointReachable": false,
                "endpoint": endpoint,
                "version": installed.get("version").and_then(Value::as_str).unwrap_or("")
            },
            "installedModels": local_models,
            "recommendedModel": recommended,
            "profiles": local_model_profiles(),
            "fallbackChain": fallback_chain,
            "ruleBasedActive": true,
            "llm": masked_llm_config_for_root(root).get("llm").cloned().unwrap_or(Value::Null),
        });
    }
    let model_list = list_ollama_models_value(&endpoint);
    let runtime_models = model_list
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let local_models = list_local_ai_model_files();
    let models = merge_local_ai_model_lists(runtime_models, local_models);
    let model_names: Vec<String> = model_list
        .get("modelNames")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let model_names: Vec<String> = merge_local_ai_model_lists(
        model_names
            .into_iter()
            .map(|name| json!({ "name": name }))
            .collect(),
        models.clone(),
    )
    .iter()
    .filter_map(|model| {
        model
            .get("name")
            .or_else(|| model.get("model"))
            .and_then(Value::as_str)
            .map(str::to_string)
    })
    .collect();
    let recommended_name = recommended
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let llm_config = masked_llm_config_for_root(root)
        .get("llm")
        .cloned()
        .unwrap_or(Value::Null);
    let configured_model = llm_config
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("");
    let recommended_installed = model_names.iter().any(|name| name == recommended_name);
    let configured_installed =
        !configured_model.is_empty() && model_names.iter().any(|name| name == configured_model);
    let any_model_installed = !model_names.is_empty();
    let model_ready = recommended_installed || configured_installed || any_model_installed;
    let status_message = if recommended_installed {
        "Recommended model is installed."
    } else if configured_installed {
        "Configured Local AI model is installed."
    } else if any_model_installed {
        "A local model is installed."
    } else {
        "Recommended model is missing."
    };
    json!({
        "ok": true,
        "available": true,
        "status": if model_ready { "model_ready" } else { "model_missing" },
        "message": status_message,
        "system": profile,
        "ollama": {
            "installed": true,
            "running": true,
            "endpointReachable": true,
            "endpoint": endpoint,
            "version": running.get("version").and_then(Value::as_str).unwrap_or("")
        },
        "installedModels": models,
        "recommendedModel": recommended,
        "profiles": local_model_profiles(),
        "fallbackChain": fallback_chain,
        "ruleBasedActive": true,
        "llm": llm_config,
    })
}

fn normalize_pull_progress_line(model: &str, line: &str) -> Value {
    let parsed = serde_json::from_str::<Value>(line).unwrap_or_else(|_| json!({ "status": line }));
    let completed = parsed.get("completed").and_then(Value::as_i64);
    let total = parsed.get("total").and_then(Value::as_i64);
    let percent = match (completed, total) {
        (Some(done), Some(total)) if total > 0 => Some((done as f64 / total as f64) * 100.0),
        _ => None,
    };
    json!({
        "model": model,
        "status": parsed.get("status").and_then(Value::as_str).unwrap_or("downloading"),
        "digest": parsed.get("digest").and_then(Value::as_str).unwrap_or(""),
        "completedBytes": completed,
        "totalBytes": total,
        "percent": percent,
        "done": parsed.get("status").and_then(Value::as_str).unwrap_or("") == "success",
    })
}

fn ollama_pull_cancelled_value(model: &str) -> Value {
    json!({
        "ok": false,
        "status": "cancelled",
        "model": model,
        "message": "Model download cancelled.",
        "percent": 0,
        "done": true,
    })
}

fn is_ollama_pull_cancelled() -> bool {
    CANCEL_OLLAMA_PULL.load(Ordering::SeqCst)
}

fn run_ollama_pull(app: &tauri::AppHandle, payload: &Value) -> Value {
    let endpoint = endpoint_from_payload(payload);
    let model = model_from_payload(payload);
    CANCEL_OLLAMA_PULL.store(false, Ordering::SeqCst);
    let starting = json!({
        "model": model,
        "status": "preparing runtime",
        "message": "Preparing Local AI runtime...",
        "completedBytes": Value::Null,
        "totalBytes": Value::Null,
        "percent": 5,
        "done": false,
    });
    let _ = app.emit("market-agent:ollama-pull-progress", starting);
    if is_ollama_pull_cancelled() {
        let cancelled = ollama_pull_cancelled_value(&model);
        let _ = app.emit("market-agent:ollama-pull-progress", cancelled.clone());
        return cancelled;
    }
    let runtime_preparing = json!({
        "model": model,
        "status": "starting runtime",
        "message": "Starting Local AI runtime...",
        "completedBytes": Value::Null,
        "totalBytes": Value::Null,
        "percent": 15,
        "done": false,
    });
    let _ = app.emit("market-agent:ollama-pull-progress", runtime_preparing);
    if is_ollama_pull_cancelled() {
        let cancelled = ollama_pull_cancelled_value(&model);
        let _ = app.emit("market-agent:ollama-pull-progress", cancelled.clone());
        return cancelled;
    }
    let running = prepare_ollama_runtime(&endpoint);
    if is_ollama_pull_cancelled() {
        let cancelled = ollama_pull_cancelled_value(&model);
        let _ = app.emit("market-agent:ollama-pull-progress", cancelled.clone());
        return cancelled;
    }
    if !running
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let message = running
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Local AI runtime is still preparing in the background.");
        let failed = json!({
            "ok": false,
            "status": running.get("status").and_then(Value::as_str).unwrap_or("runtime_preparing"),
            "model": model,
            "message": message,
            "error": running.get("error").and_then(Value::as_str).unwrap_or(""),
            "done": true,
        });
        let _ = app.emit("market-agent:ollama-pull-progress", failed.clone());
        return failed;
    }
    let url = format!("{}/api/pull", endpoint.trim_end_matches('/'));
    let requesting = json!({
        "model": model,
        "status": "requesting model",
        "message": "Requesting Local AI model files...",
        "completedBytes": Value::Null,
        "totalBytes": Value::Null,
        "percent": 25,
        "done": false,
    });
    let _ = app.emit("market-agent:ollama-pull-progress", requesting);
    let response = match ureq::post(&url)
        .timeout(Duration::from_secs(60 * 60))
        .send_json(json!({ "name": model, "stream": true }))
    {
        Ok(response) => response,
        Err(err) => {
            let failed = json!({
                "ok": false,
                "status": "download_failed",
                "model": model,
                "message": "Local AI model could not finish downloading. Rule-based analysis remains active.",
                "error": err.to_string(),
                "done": true,
            });
            let _ = app.emit("market-agent:ollama-pull-progress", failed.clone());
            return failed;
        }
    };
    let reader = BufReader::new(response.into_reader());
    let mut last_progress = json!({
        "model": model,
        "status": "downloading",
        "completedBytes": Value::Null,
        "totalBytes": Value::Null,
        "percent": Value::Null,
        "done": false,
    });
    for line in reader.lines().map_while(Result::ok) {
        if is_ollama_pull_cancelled() {
            let cancelled = ollama_pull_cancelled_value(&model);
            let _ = app.emit("market-agent:ollama-pull-progress", cancelled.clone());
            return cancelled;
        }
        if line.trim().is_empty() {
            continue;
        }
        last_progress = normalize_pull_progress_line(&model, &line);
        let _ = app.emit("market-agent:ollama-pull-progress", last_progress.clone());
    }

    let model_list = list_ollama_models_value(&endpoint);
    let model_names: Vec<String> = model_list
        .get("modelNames")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if !model_names.iter().any(|name| name == &model) {
        return json!({
            "ok": false,
            "status": "model_missing",
            "model": model,
            "message": "Model download completed, but Local AI did not report the model in the app model list.",
            "progress": last_progress,
        });
    }

    let validation_payload = json!({
        "endpoint": endpoint,
        "model": model,
        "timeoutSeconds": payload.get("timeoutSeconds").and_then(Value::as_i64).unwrap_or(DEFAULT_LLM_TIMEOUT_SECONDS),
    });
    let validation = benchmark_llm_value(&validation_payload);
    if !validation
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "ok": false,
            "status": validation.get("status").and_then(Value::as_str).unwrap_or("validation_failed"),
            "model": model,
            "message": "Model download completed, but JSON or benchmark validation failed.",
            "error": validation.get("error").and_then(Value::as_str).unwrap_or(""),
            "elapsedMs": validation.get("elapsedMs").cloned().unwrap_or(Value::Null),
            "policy": validation.get("policy").cloned().unwrap_or(Value::Null),
            "progress": last_progress,
        });
    }

    json!({
        "ok": true,
        "status": "model_ready",
        "model": model,
        "message": "Model download completed; strict JSON and benchmark checks passed.",
        "progress": last_progress,
        "benchmark": validation,
    })
}

fn benchmark_llm_value(payload: &Value) -> Value {
    let merged = merged_llm_config_for_root(&config::appdata_dir(), Some(payload));
    let endpoint = merged
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_OLLAMA_ENDPOINT)
        .trim_end_matches('/')
        .to_string();
    let model = merged
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("qwen3.5:4b")
        .to_string();
    let timeout_seconds = merged
        .get("timeoutSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_LLM_TIMEOUT_SECONDS)
        .max(3) as u64;
    let started = Instant::now();
    let response = ureq::post(&format!("{endpoint}/api/generate"))
        .timeout(Duration::from_secs(timeout_seconds))
        .send_json(json!({
            "model": model,
            "stream": false,
            "format": "json",
            "prompt": "Return JSON only: {\"main_driver\":\"unknown\",\"cause_status\":\"unconfirmed\",\"confidence\":\"low\",\"thesis\":\"insufficient evidence\"}",
            "options": {"temperature": 0.0, "num_ctx": 1024},
            "keep_alive": "0"
        }));
    let elapsed_ms = started.elapsed().as_millis() as i64;
    match response {
        Ok(response) => {
            let payload = response.into_json::<Value>().unwrap_or_else(|_| json!({}));
            let valid_json = payload
                .get("response")
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .and_then(|value| value.as_object().cloned())
                .is_some();
            if !valid_json {
                return json!({
                    "ok": false,
                    "status": "invalid_json",
                    "model": model,
                    "elapsedMs": elapsed_ms,
                    "policy": apply_llm_fallback_policy_for_result(&model, "invalid_json", Some(elapsed_ms)),
                    "error": "Benchmark response was not strict JSON."
                });
            }
            if elapsed_ms > 8_000 {
                return json!({
                    "ok": false,
                    "status": "model_too_slow",
                    "model": model,
                    "elapsedMs": elapsed_ms,
                    "policy": apply_llm_fallback_policy_for_result(&model, "model_too_slow", Some(elapsed_ms)),
                    "message": "Model benchmark is too slow for low-maintenance monitoring."
                });
            }
            json!({
                "ok": true,
                "status": "model_ready",
                "model": model,
                "elapsedMs": elapsed_ms,
                "message": "Model returned strict JSON within the benchmark threshold."
            })
        }
        Err(err) => json!({
            "ok": false,
            "status": "unavailable",
            "model": model,
            "elapsedMs": elapsed_ms,
            "policy": apply_llm_fallback_policy_for_result(&model, "unavailable", Some(elapsed_ms)),
            "error": err.to_string()
        }),
    }
}

fn test_llm_for_root(root: &Path, payload: &Value, mode: &str) -> Value {
    let merged = merged_llm_config_for_root(root, Some(payload));
    let workdir = repo_root_from_manifest()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| root.to_path_buf());
    let mut command = Command::new("python");
    command
        .args(["-m", "src.xauusd_market_agent.llm_bridge", mode])
        .current_dir(&workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_child_window(&mut command);
    append_spawn_debug(
        root,
        json!({
            "ts": chrono::Utc::now().to_rfc3339(),
            "event": "spawn_request",
            "layer": "tauri_llm_bridge",
            "program": "python",
            "args": ["-m", "src.xauusd_market_agent.llm_bridge", mode],
            "cwd": workdir.display().to_string(),
        }),
    );
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            append_spawn_debug(
                root,
                json!({
                    "ts": chrono::Utc::now().to_rfc3339(),
                    "event": "spawn_error",
                    "layer": "tauri_llm_bridge",
                    "program": "python",
                    "args": ["-m", "src.xauusd_market_agent.llm_bridge", mode],
                    "error": err.to_string(),
                }),
            );
            return json!({
                "ok": false,
                "status": "unavailable",
                "error": format!("Unable to start LLM bridge: {err}"),
                "llm": masked_llm_config_for_root(root).get("llm").cloned().unwrap_or(Value::Null),
            });
        }
    };
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(merged.to_string().as_bytes());
    }
    let parsed = match child.wait_with_output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            append_spawn_debug(
                root,
                json!({
                    "ts": chrono::Utc::now().to_rfc3339(),
                    "event": "spawn_result",
                    "layer": "tauri_llm_bridge",
                    "program": "python",
                    "args": ["-m", "src.xauusd_market_agent.llm_bridge", mode],
                    "success": output.status.success(),
                    "code": output.status.code(),
                    "stdout_preview": stdout.chars().take(240).collect::<String>(),
                    "stderr_preview": stderr.chars().take(240).collect::<String>(),
                }),
            );
            if !output.status.success() {
                json!({
                    "ok": false,
                    "status": "unavailable",
                    "error": if stderr.is_empty() { stdout } else { stderr },
                })
            } else {
                serde_json::from_str::<Value>(&stdout).unwrap_or_else(|err| {
                    json!({
                        "ok": false,
                        "status": "invalid_json",
                        "error": format!("Unable to parse LLM bridge JSON: {err}"),
                    })
                })
            }
        }
        Err(err) => json!({
            "ok": false,
            "status": "unavailable",
            "error": format!("Unable to wait for LLM bridge: {err}"),
        }),
    };
    let status = parsed.get("status").and_then(Value::as_str).unwrap_or(
        if parsed.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            "available"
        } else {
            "unavailable"
        },
    );
    let mut updated = merged.clone();
    updated["lastStatus"] = Value::String(status.to_string());
    updated["lastError"] = Value::String(
        parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    );
    let _ = write_json_atomic(&llm_config_path_for_root(root), &updated);
    json!({
        "ok": parsed.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "status": status,
        "message": parsed.get("message").and_then(Value::as_str).unwrap_or("LLM test completed."),
        "error": parsed.get("error").and_then(Value::as_str).unwrap_or(""),
        "llm": masked_llm_config_for_root(root).get("llm").cloned().unwrap_or(Value::Null),
    })
}

fn telegram_env_for_root(root: &Path) -> HashMap<String, String> {
    let merged = merged_telegram_config_for_root(root, None);
    let mut env = HashMap::new();
    env.insert(
        "MARKET_AGENT_TELEGRAM_ENABLED".to_string(),
        if merged
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "true".to_string()
        } else {
            "false".to_string()
        },
    );
    env.insert(
        "MARKET_AGENT_TELEGRAM_BOT_TOKEN".to_string(),
        merged
            .get("botToken")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    );
    env.insert(
        "MARKET_AGENT_TELEGRAM_CHAT_ID".to_string(),
        merged
            .get("chatId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    );
    env.insert(
        "MARKET_AGENT_TELEGRAM_TIMEOUT_SECONDS".to_string(),
        merged
            .get("timeoutSeconds")
            .and_then(Value::as_i64)
            .unwrap_or(10)
            .to_string(),
    );
    let levels = merged
        .get("levels")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_else(|| "level_2,level_3".to_string());
    env.insert("MARKET_AGENT_TELEGRAM_LEVELS".to_string(), levels);
    env
}

fn ctrader_env_for_root(root: &Path) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let live_quote_path = live_quote_snapshot_path_for_root(root)
        .display()
        .to_string();
    env.insert(
        "CTRADER_CONFIG_PATH".to_string(),
        ctrader_config_path_for_root(root).display().to_string(),
    );
    env.insert("CTRADER_SNAPSHOT_PATH".to_string(), live_quote_path.clone());
    env.insert(
        "MARKET_AGENT_CTRADER_SAVED_SNAPSHOT_PATH".to_string(),
        live_quote_path,
    );
    env.insert(
        "CTRADER_QUOTE_BRIDGE_ENABLED".to_string(),
        "false".to_string(),
    );
    env
}

fn wait_for_child_output_with_timeout(
    mut child: std::process::Child,
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut stream) = child.stdout.take() {
                    let _ = stream.read_to_string(&mut stdout);
                }
                if let Some(mut stream) = child.stderr.take() {
                    let _ = stream.read_to_string(&mut stderr);
                }
                return Ok((
                    status.success(),
                    stdout.trim().to_string(),
                    stderr.trim().to_string(),
                ));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Timed out waiting for Telegram test response.".to_string());
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(err) => return Err(format!("Unable to wait for Telegram bridge: {err}")),
        }
    }
}

fn test_telegram_for_root(root: &Path, payload: &Value) -> Value {
    let merged = merged_telegram_config_for_root(root, Some(payload));
    let bot_token = merged
        .get("botToken")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let chat_id = merged
        .get("chatId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if bot_token.is_empty() || chat_id.is_empty() {
        return json!({
            "ok": false,
            "status": "failed",
            "error": "Telegram bot token and chat ID are required.",
            "telegram": masked_telegram_config_for_root(root).get("telegram").cloned().unwrap_or(Value::Null),
        });
    }
    let workdir = repo_root_from_manifest()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| root.to_path_buf());
    let mut command = Command::new("python");
    command
        .args(["-m", "src.xauusd_market_agent.telegram_bridge"])
        .current_dir(&workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_child_window(&mut command);
    append_spawn_debug(
        root,
        json!({
            "ts": chrono::Utc::now().to_rfc3339(),
            "event": "spawn_request",
            "layer": "tauri_telegram_bridge",
            "program": "python",
            "args": ["-m", "src.xauusd_market_agent.telegram_bridge"],
            "cwd": workdir.display().to_string(),
        }),
    );
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            append_spawn_debug(
                root,
                json!({
                    "ts": chrono::Utc::now().to_rfc3339(),
                    "event": "spawn_error",
                    "layer": "tauri_telegram_bridge",
                    "program": "python",
                    "args": ["-m", "src.xauusd_market_agent.telegram_bridge"],
                    "error": err.to_string(),
                }),
            );
            return json!({
                "ok": false,
                "status": "failed",
                "error": format!("Unable to start Telegram bridge: {err}"),
                "telegram": masked_telegram_config_for_root(root).get("telegram").cloned().unwrap_or(Value::Null),
            });
        }
    };
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(merged.to_string().as_bytes());
    }
    let timeout_seconds = merged
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .clamp(5, 30)
        + 3;
    let parsed =
        match wait_for_child_output_with_timeout(child, Duration::from_secs(timeout_seconds)) {
            Ok((success, stdout, stderr)) => {
                append_spawn_debug(
                    root,
                    json!({
                        "ts": chrono::Utc::now().to_rfc3339(),
                        "event": "spawn_result",
                        "layer": "tauri_telegram_bridge",
                        "program": "python",
                        "args": ["-m", "src.xauusd_market_agent.telegram_bridge"],
                        "success": success,
                        "stdout_preview": stdout.chars().take(240).collect::<String>(),
                        "stderr_preview": stderr.chars().take(240).collect::<String>(),
                    }),
                );
                if !success {
                    json!({
                        "ok": false,
                        "status": "failed",
                        "error": if stderr.is_empty() { stdout } else { stderr },
                    })
                } else {
                    serde_json::from_str::<Value>(&stdout).unwrap_or_else(|err| {
                        json!({
                            "ok": false,
                            "status": "failed",
                            "error": format!("Unable to parse Telegram bridge JSON: {err}"),
                        })
                    })
                }
            }
            Err(err) => json!({
                "ok": false,
                "status": "failed",
                "error": err,
            }),
        };
    let status = if parsed.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        "sent"
    } else {
        "failed"
    };
    let mut updated = merged.clone();
    updated["lastSendStatus"] = Value::String(status.to_string());
    updated["lastError"] = Value::String(
        parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    );
    let _ = write_json_atomic(&telegram_config_path_for_root(root), &updated);
    json!({
        "ok": status == "sent",
        "status": status,
        "message": parsed.get("message").and_then(Value::as_str).unwrap_or(if status == "sent" {
            "Test message sent."
        } else {
            "Test message could not be confirmed."
        }),
        "error": parsed.get("error").and_then(Value::as_str).unwrap_or(""),
        "telegram": masked_telegram_config_for_root(root).get("telegram").cloned().unwrap_or(Value::Null),
    })
}

fn clear_ctrader_provider_config(root: &Path) -> Result<Value, String> {
    let config_path = ctrader_config_path_for_root(root);
    let _ = fs::remove_file(config_path);
    let legacy_token_file = format!("{}.json", ["ctrader", "token"].join("-"));
    let _ = fs::remove_file(root.join(legacy_token_file));
    Ok(masked_ctrader_provider_config(root))
}

fn is_ctrader_shell_adapter_executable(executable: &str) -> bool {
    let trimmed = executable.trim();
    if trimmed.is_empty() {
        return false;
    }
    let path = Path::new(trimmed);
    let suffix = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    matches!(suffix.as_str(), "cmd" | "bat" | "ps1") || file_name.contains("ctrader-cli-adapter")
}

fn ctrader_cli_bridge_block_reason(merged: &Value, command: &str) -> Option<String> {
    let executable = merged
        .get("cliExecutable")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if is_ctrader_shell_adapter_executable(executable) {
        return Some(format!(
            "cTrader CLI adapter shell is disabled for {command} because it starts cmd/powershell/dotnet processes. Use the long-running connector snapshot for live data."
        ));
    }
    None
}

fn run_ctrader_bridge(root: &Path, command: &str, payload: &Value) -> Value {
    let merged = merged_ctrader_provider_config(root, Some(payload));
    if let Some(error) = ctrader_cli_bridge_block_reason(&merged, command) {
        append_spawn_debug(
            root,
            json!({
                "ts": chrono::Utc::now().to_rfc3339(),
                "event": "blocked",
                "layer": "tauri_ctrader_bridge",
                "command": command,
                "reason": "shell_adapter_disabled",
            }),
        );
        return json!({
            "ok": false,
            "status": "disabled",
            "error": error,
            "message": error,
        });
    }
    let workdir = repo_root_from_manifest()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| root.to_path_buf());
    let mut child_command = Command::new("python");
    child_command
        .args([
            "-m",
            "src.xauusd_market_agent.providers.ctrader_bridge",
            command,
        ])
        .current_dir(&workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_child_window(&mut child_command);
    append_spawn_debug(
        root,
        json!({
            "ts": chrono::Utc::now().to_rfc3339(),
            "event": "spawn_request",
            "layer": "tauri_ctrader_bridge",
            "program": "python",
            "args": ["-m", "src.xauusd_market_agent.providers.ctrader_bridge", command],
            "cwd": workdir.display().to_string(),
        }),
    );
    let mut child = match child_command.spawn() {
        Ok(child) => child,
        Err(err) => {
            append_spawn_debug(
                root,
                json!({
                    "ts": chrono::Utc::now().to_rfc3339(),
                    "event": "spawn_error",
                    "layer": "tauri_ctrader_bridge",
                    "program": "python",
                    "args": ["-m", "src.xauusd_market_agent.providers.ctrader_bridge", command],
                    "error": err.to_string(),
                }),
            );
            return json!({
                "ok": false,
                "error": format!("Unable to start cTrader CLI adapter: {err}"),
            });
        }
    };
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(merged.to_string().as_bytes());
    }
    match child.wait_with_output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            append_spawn_debug(
                root,
                json!({
                    "ts": chrono::Utc::now().to_rfc3339(),
                    "event": "spawn_result",
                    "layer": "tauri_ctrader_bridge",
                    "program": "python",
                    "args": ["-m", "src.xauusd_market_agent.providers.ctrader_bridge", command],
                    "success": output.status.success(),
                    "code": output.status.code(),
                    "stdout_preview": stdout.chars().take(400).collect::<String>(),
                    "stderr_preview": stderr.chars().take(400).collect::<String>(),
                }),
            );
            if !output.status.success() {
                let raw_error = if stderr.is_empty() { stdout } else { stderr };
                if let Ok(parsed) = serde_json::from_str::<Value>(&raw_error) {
                    if parsed.is_object() {
                        return normalize_ctrader_bridge_error(parsed);
                    }
                }
                return json!({
                    "ok": false,
                    "error": raw_error,
                });
            }
            let parsed = serde_json::from_str::<Value>(&stdout).unwrap_or_else(|err| {
                json!({
                    "ok": false,
                    "error": format!("Unable to parse cTrader CLI adapter JSON: {err}"),
                    "raw": stdout,
                })
            });
            parsed
        }
        Err(err) => json!({
            "ok": false,
            "error": format!("Unable to wait for cTrader CLI adapter: {err}"),
        }),
    }
}

fn normalize_ctrader_bridge_error(parsed: Value) -> Value {
    let nested = parsed
        .get("error")
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let Some(mut nested) = nested else {
        return parsed;
    };
    if !nested.is_object() {
        return parsed;
    }
    if let Some(payload) = parsed.get("payload").cloned() {
        if nested.get("payload").is_none() {
            nested["payload"] = payload;
        }
    }
    nested
}

fn test_ctrader_backfill_for_root(root: &Path, payload: &Value) -> Value {
    let now = chrono::Utc::now();
    let start = (now - chrono::Duration::minutes(3)).to_rfc3339();
    let end = now.to_rfc3339();
    let mut merged = merged_ctrader_provider_config(root, Some(payload));
    merged["start"] = Value::String(start);
    merged["end"] = Value::String(end);
    let result = run_ctrader_bridge(root, "backfill", &merged);
    if result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        json!({
            "ok": true,
            "message": "M1 trendbar backfill is available.",
            "provider_health": result.get("provider_health").cloned().unwrap_or(Value::Null),
        })
    } else {
        result
    }
}

fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

fn status_path_age_seconds(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let now = SystemTime::now();
    let age = now.duration_since(modified).ok()?;
    Some(age.as_secs() as i64)
}

fn live_quote_snapshot_has_price(snapshot: &Value) -> bool {
    snapshot.get("mid").is_some() || snapshot.get("bid").is_some() || snapshot.get("ask").is_some()
}

fn quote_timestamp_utc(snapshot: &Value) -> Option<chrono::DateTime<chrono::Utc>> {
    let raw = snapshot
        .get("timestamp")
        .or_else(|| snapshot.get("data_timestamp"))
        .or_else(|| snapshot.get("server_time"))
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(&raw)
        .ok()
        .map(|value| value.with_timezone(&chrono::Utc))
}

fn xauusd_weekend_closed_at(now_utc: chrono::DateTime<chrono::Utc>) -> bool {
    match now_utc.weekday() {
        chrono::Weekday::Sat => true,
        chrono::Weekday::Sun => now_utc.hour() < XAUUSD_WEEKEND_REOPEN_HOUR_UTC,
        chrono::Weekday::Fri => now_utc.hour() >= XAUUSD_WEEKEND_CLOSE_HOUR_UTC,
        _ => false,
    }
}

fn live_quote_snapshot_is_fresh_at(root: &Path, now_utc: chrono::DateTime<chrono::Utc>) -> bool {
    let snapshot_path = live_quote_snapshot_path_for_root(root);
    let Some(snapshot) = read_json_file(&snapshot_path) else {
        return false;
    };
    if snapshot.get("ok").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    if !live_quote_snapshot_has_price(&snapshot) {
        return false;
    }
    let Some(timestamp) = quote_timestamp_utc(&snapshot) else {
        return false;
    };
    let age_seconds = now_utc.signed_duration_since(timestamp).num_seconds();
    (0..=LIVE_QUOTE_FRESH_AFTER_SECONDS).contains(&age_seconds)
}

fn live_quote_snapshot_is_fresh(root: &Path) -> bool {
    live_quote_snapshot_is_fresh_at(root, chrono::Utc::now())
}

fn stale_live_quote_context(
    snapshot: Option<&Value>,
    now_utc: chrono::DateTime<chrono::Utc>,
) -> (&'static str, String, Value) {
    let timestamp = snapshot.and_then(quote_timestamp_utc);
    let age_seconds = timestamp.map(|value| now_utc.signed_duration_since(value).num_seconds());
    if xauusd_weekend_closed_at(now_utc)
        && age_seconds
            .map(|value| (0..=MAX_WEEKEND_CONTEXT_AGE_SECONDS).contains(&value))
            .unwrap_or(false)
    {
        return (
            "market_closed",
            "XAUUSD is inside the weekend closed window; last cTrader quote is context only until the market reopens.".to_string(),
            json!({
                "stale_classification": "market_closed",
                "quote_age_seconds": age_seconds,
                "market_closed": true,
            }),
        );
    }
    (
        "stale",
        "Live quote snapshot is stale; waiting for fresh cTrader stream.".to_string(),
        json!({
            "stale_classification": if timestamp.is_some() { "feed_paused" } else { "invalid_timestamp" },
            "quote_age_seconds": age_seconds,
            "market_closed": false,
        }),
    )
}

fn should_probe_monitor_pid(root: &Path, status: &Value) -> bool {
    let running = status
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let pid = status.get("pid").and_then(Value::as_i64).unwrap_or(0);
    if !running || pid <= 0 {
        return false;
    }
    let interval_seconds = status
        .get("intervalSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(60)
        .max(10);
    let freshness_window = (interval_seconds * 2).max(30);
    let status_age =
        status_path_age_seconds(&monitor_status_path_for_root(root)).unwrap_or(i64::MAX);
    status_age > freshness_window
}

#[cfg(target_os = "windows")]
fn is_process_running(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
    if handle == 0 {
        return false;
    }
    let mut exit_code = 0u32;
    let ok = unsafe {
        GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code == STILL_ACTIVE as u32
    };
    unsafe {
        CloseHandle(handle);
    }
    ok
}

#[cfg(not(target_os = "windows"))]
fn is_process_running(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn read_monitor_status_for_root(root: &Path) -> Value {
    let mut status = read_json_file(&monitor_status_path_for_root(root)).unwrap_or_else(|| {
        json!({
            "ok": true,
            "available": true,
            "running": false,
            "phase": "stopped",
            "pid": null,
            "lastRunAt": null,
            "nextRunAt": null,
            "lastError": "",
            "message": "Monitor loop is stopped.",
        })
    });
    let running = status
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !running {
        let last_error = status
            .get("lastError")
            .and_then(Value::as_str)
            .unwrap_or("");
        let message = status.get("message").and_then(Value::as_str).unwrap_or("");
        let combined = format!("{last_error}\n{message}").to_ascii_lowercase();
        if combined.contains("process that is no longer running")
            || combined.contains("monitor loop stopped unexpectedly")
            || combined.contains("saved monitor status referenced")
        {
            normalize_stopped_monitor_status(&mut status);
            let _ = write_monitor_status_for_root(root, &status);
            return status;
        }
    }
    if should_probe_monitor_pid(root, &status) {
        let pid = status.get("pid").and_then(Value::as_i64).unwrap_or(0);
        if !is_process_running(pid) {
            normalize_stopped_monitor_status(&mut status);
            let _ = write_monitor_status_for_root(root, &status);
        }
    }
    normalize_legacy_market_agent_status(&mut status);
    sync_monitor_status_with_latest_timeline_run(root, &mut status);
    status
}

fn normalize_legacy_market_agent_status(status: &mut Value) {
    normalize_legacy_ctrader_activity(status);
}

fn sync_monitor_status_with_latest_timeline_run(root: &Path, status: &mut Value) {
    let Ok(connection) = open_timeline_db(root) else {
        return;
    };
    let Ok(Some((monitor_run_id, run_started_at, data_mode))) =
        query_latest_monitor_run(&connection)
    else {
        return;
    };
    let current_monitor_run_id = status.get("latestMonitorRunId").and_then(Value::as_i64);
    let last_run_at = status.get("lastRunAt").and_then(Value::as_str);
    let running = status
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let activity_is_older = current_monitor_run_id != Some(monitor_run_id)
        || last_run_at
            .map(|value| value != run_started_at)
            .unwrap_or(true);
    let has_activity = status.get("activity").is_some();
    if let Some(object) = status.as_object_mut() {
        object.insert(
            "latestMonitorRunId".to_string(),
            Value::from(monitor_run_id),
        );
        object.insert(
            "latestStoredRunAt".to_string(),
            Value::String(run_started_at.clone()),
        );
        object.insert(
            "latestStoredDataMode".to_string(),
            Value::String(data_mode.clone()),
        );
        object.insert(
            "activityStale".to_string(),
            Value::Bool(activity_is_older && has_activity),
        );
        if !running && activity_is_older {
            object.insert(
                "lastRunAt".to_string(),
                Value::String(run_started_at.clone()),
            );
            object.insert(
                "message".to_string(),
                Value::String(format!(
                    "Monitor loop is stopped. Latest stored run is {run_started_at}; activity trace is from an older status snapshot."
                )),
            );
        }
    }
}

fn normalize_legacy_ctrader_activity(status: &mut Value) {
    let Some(activity) = status.get_mut("activity").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(ctrader) = activity.get_mut("ctrader").and_then(Value::as_object_mut) else {
        return;
    };

    if let Some(provider_chain) = ctrader
        .get_mut("providerChain")
        .and_then(Value::as_array_mut)
    {
        provider_chain.retain(|item| {
            item.get("provider")
                .and_then(Value::as_str)
                .map(|provider| provider != "csv_fallback")
                .unwrap_or(true)
        });
    }

    if let Some(jobs) = ctrader.get_mut("jobs").and_then(Value::as_array_mut) {
        jobs.retain(|item| {
            let title = item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            !title.contains("csv fallback")
        });
        for job in jobs.iter_mut() {
            if let Some(title) = job.get_mut("title") {
                if title.as_str() == Some("Ctrader Spot check") {
                    *title = Value::String("cTrader spot freshness".to_string());
                } else if title.as_str() == Some("Yahoo Gc F Proxy check") {
                    *title = Value::String("GC=F proxy check".to_string());
                } else if title.as_str() == Some("Csv Fallback check") {
                    *title = Value::String("CSV import check".to_string());
                }
            }
            if let Some(detail) = job.get_mut("detail") {
                if detail
                    .as_str()
                    .map(|text| text.contains("CSV fallback is debug/import only"))
                    .unwrap_or(false)
                {
                    *detail = Value::String("Live cTrader spot is unavailable.".to_string());
                }
            }
        }
    }

    if ctrader
        .get("detail")
        .and_then(Value::as_str)
        .map(|detail| detail.contains("CSV fallback is debug/import only."))
        .unwrap_or(false)
    {
        ctrader.insert(
            "detail".to_string(),
            Value::String("Live cTrader spot is unavailable.".to_string()),
        );
    }

    if ctrader
        .get("fallbackReason")
        .and_then(Value::as_str)
        .map(|reason| reason.contains("CSV fallback is debug/import only"))
        .unwrap_or(false)
    {
        ctrader.insert("fallbackReason".to_string(), Value::String(String::new()));
    }

    if let Some(provider_health) = ctrader
        .get_mut("providerHealth")
        .and_then(Value::as_object_mut)
    {
        for key in ["stale_reason", "error"] {
            if provider_health
                .get(key)
                .and_then(Value::as_str)
                .map(|text| text.contains("CSV fallback is debug/import only"))
                .unwrap_or(false)
            {
                provider_health.insert(
                    key.to_string(),
                    Value::String("Live cTrader spot is unavailable.".to_string()),
                );
            }
        }
    }
}

fn normalize_stopped_monitor_status(status: &mut Value) {
    if let Some(object) = status.as_object_mut() {
        object.insert("ok".to_string(), Value::Bool(true));
        object.insert("available".to_string(), Value::Bool(true));
        object.insert("running".to_string(), Value::Bool(false));
        object.insert("phase".to_string(), Value::String("stopped".to_string()));
        object.insert("pid".to_string(), Value::Null);
        object.insert("monitorOwnerPid".to_string(), Value::Null);
        object.insert("nextRunAt".to_string(), Value::Null);
        object.insert("lastError".to_string(), Value::String(String::new()));
        object.insert(
            "message".to_string(),
            Value::String("Monitor loop is stopped.".to_string()),
        );
    }
}

fn strip_monitor_activity(mut status: Value) -> Value {
    if let Some(object) = status.as_object_mut() {
        object.remove("activity");
    }
    status
}

fn read_monitor_status_for_root_with_activity(root: &Path, include_activity: bool) -> Value {
    let status = read_monitor_status_for_root(root);
    if include_activity {
        status
    } else {
        strip_monitor_activity(status)
    }
}

fn write_monitor_status_for_root(root: &Path, status: &Value) -> Result<(), String> {
    write_json_atomic(&monitor_status_path_for_root(root), status)
}

fn merge_monitor_status_for_root(root: &Path, updates: Value) -> Value {
    let mut current = read_monitor_status_for_root(root);
    if let (Some(current_object), Some(update_object)) =
        (current.as_object_mut(), updates.as_object())
    {
        for (key, value) in update_object {
            current_object.insert(key.clone(), value.clone());
        }
        current
    } else {
        updates
    }
}

fn repo_root_for_monitor(root: &Path) -> PathBuf {
    repo_root_from_manifest()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| root.to_path_buf())
}

#[cfg(target_os = "windows")]
fn monitor_python_program() -> &'static str {
    "pythonw"
}

#[cfg(not(target_os = "windows"))]
fn monitor_python_program() -> &'static str {
    "python"
}

fn monitor_command_base(root: &Path) -> Command {
    let mut command = Command::new(monitor_python_program());
    command
        .current_dir(repo_root_for_monitor(root))
        .env("MARKET_AGENT_STATE_STORE_PATH", state_path_for_root(root))
        .env(
            "MARKET_AGENT_ALERTS_OUTPUT_PATH",
            alerts_path_for_root(root),
        )
        .env(
            "MARKET_AGENT_TIMELINE_STORE_PATH",
            timeline_path_for_root(root),
        )
        .env(
            "MARKET_AGENT_MONITOR_LOCK_PATH",
            monitor_lock_path_for_root(root),
        )
        .env(
            "MARKET_AGENT_MONITOR_STATUS_PATH",
            monitor_status_path_for_root(root),
        )
        .env(
            "MARKET_AGENT_MONITOR_OWNER_PID",
            std::process::id().to_string(),
        );
    for (key, value) in telegram_env_for_root(root) {
        command.env(key, value);
    }
    for (key, value) in ctrader_env_for_root(root) {
        command.env(key, value);
    }
    for (key, value) in llm_env_for_root(root) {
        command.env(key, value);
    }
    hide_child_window(&mut command);
    command
}

fn live_quote_command_base(root: &Path) -> Command {
    let mut command = Command::new(monitor_python_program());
    command.current_dir(repo_root_for_monitor(root));
    for (key, value) in ctrader_env_for_root(root) {
        command.env(key, value);
    }
    hide_child_window(&mut command);
    command
}

fn should_reuse_running_monitor(current: &Value, spawn_process: bool, app_pid: i64) -> bool {
    let current_running = current
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !current_running {
        return false;
    }
    if !spawn_process {
        return true;
    }
    let current_owner_pid = current
        .get("monitorOwnerPid")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    current_owner_pid == app_pid
}

#[cfg(target_os = "windows")]
fn hide_child_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
fn hide_child_window(_command: &mut Command) {}

fn start_monitor_loop_for_root(root: &Path, interval_seconds: i64, spawn_process: bool) -> Value {
    let current = read_monitor_status_for_root(root);
    let app_pid = std::process::id() as i64;
    if should_reuse_running_monitor(&current, spawn_process, app_pid) {
        return json!({
            "ok": true,
            "available": true,
            "running": true,
            "phase": "running",
            "pid": current.get("pid").cloned().unwrap_or(Value::Null),
            "message": "Monitor loop is already running.",
            "lastRunAt": current.get("lastRunAt").cloned().unwrap_or(Value::Null),
            "nextRunAt": current.get("nextRunAt").cloned().unwrap_or(Value::Null),
            "lastError": current.get("lastError").and_then(Value::as_str).unwrap_or(""),
        });
    }
    if current
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && spawn_process
    {
        let _ = stop_monitor_loop_for_root(root, true);
    }
    let pid = if spawn_process {
        let mut command = monitor_command_base(root);
        command.args([
            "-m",
            "src.xauusd_market_agent.cli",
            "--monitor-loop",
            "--interval-seconds",
            &interval_seconds.to_string(),
        ]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_child_window(&mut command);
        append_spawn_debug(
            root,
            json!({
                "ts": chrono::Utc::now().to_rfc3339(),
                "event": "spawn_request",
                "layer": "tauri_monitor_loop",
                "program": monitor_python_program(),
                "args": ["-m", "src.xauusd_market_agent.cli", "--monitor-loop", "--interval-seconds", interval_seconds.to_string()],
                "cwd": repo_root_for_monitor(root).display().to_string(),
            }),
        );
        match command.spawn() {
            Ok(child) => child.id() as i64,
            Err(err) => {
                append_spawn_debug(
                    root,
                    json!({
                        "ts": chrono::Utc::now().to_rfc3339(),
                        "event": "spawn_error",
                        "layer": "tauri_monitor_loop",
                        "program": monitor_python_program(),
                        "args": ["-m", "src.xauusd_market_agent.cli", "--monitor-loop", "--interval-seconds", interval_seconds.to_string()],
                        "error": err.to_string(),
                    }),
                );
                let status = json!({
                    "ok": false,
                    "available": true,
                    "running": false,
                    "phase": "error",
                    "pid": null,
                    "lastRunAt": null,
                    "nextRunAt": null,
                    "lastError": format!("Unable to start monitor loop: {err}"),
                    "message": "Unable to start monitor loop.",
                });
                let _ = write_monitor_status_for_root(root, &status);
                return status;
            }
        }
    } else {
        0
    };
    let now = now_epoch_seconds();
    let status = json!({
        "ok": true,
        "available": true,
        "running": true,
        "phase": "running",
        "pid": pid,
        "monitorOwnerPid": app_pid,
        "intervalSeconds": interval_seconds,
        "lastRunAt": null,
        "nextRunAt": now + interval_seconds,
        "lastError": "",
        "message": "Monitor loop is running.",
    });
    let _ = write_monitor_status_for_root(root, &status);
    status
}

fn stop_monitor_loop_for_root(root: &Path, kill_process: bool) -> Value {
    let current = read_monitor_status_for_root(root);
    let pid = current.get("pid").and_then(Value::as_i64).unwrap_or(0);
    let mut last_error = String::new();
    if kill_process && pid > 0 {
        let result = if cfg!(target_os = "windows") {
            let mut command = Command::new("taskkill");
            command
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            hide_child_window(&mut command);
            command.output()
        } else {
            Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output()
        };
        if let Ok(output) = result {
            if !output.status.success() {
                last_error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            }
        }
    }
    let _ = fs::remove_file(monitor_lock_path_for_root(root));
    let status = json!({
        "ok": last_error.is_empty(),
        "available": true,
        "running": false,
        "phase": if last_error.is_empty() { "stopped" } else { "error" },
        "pid": null,
        "monitorOwnerPid": null,
        "lastRunAt": current.get("lastRunAt").cloned().unwrap_or(Value::Null),
        "nextRunAt": null,
        "lastError": last_error,
        "message": if last_error.is_empty() { "Monitor loop is stopped." } else { "Unable to stop monitor loop cleanly." },
    });
    let _ = write_monitor_status_for_root(root, &status);
    status
}

fn run_monitor_once_for_root(root: &Path) -> Value {
    let mut command = monitor_command_base(root);
    command.args(["-m", "src.xauusd_market_agent.cli", "--monitor-once"]);
    hide_child_window(&mut command);
    let output = command.output();
    let now = now_epoch_seconds();
    let current = read_monitor_status_for_root(root);
    let current_last_run = current.get("lastRunAt").cloned().unwrap_or(json!(now));
    let current_last_success = current
        .get("lastSuccessAt")
        .cloned()
        .unwrap_or_else(|| current_last_run.clone());
    let status = match output {
        Ok(output) if output.status.success() => merge_monitor_status_for_root(
            root,
            json!({
                "ok": true,
                "available": true,
                "running": false,
                "phase": "stopped",
                "pid": null,
                "lastRunAt": current_last_run,
                "lastSuccessAt": current_last_success,
                "nextRunAt": null,
                "lastError": "",
                "message": current.get("message").and_then(Value::as_str).unwrap_or("Monitor run completed."),
            }),
        ),
        Ok(output) => json!({
            "ok": false,
            "available": true,
            "running": false,
            "phase": "error",
            "pid": null,
            "lastRunAt": now,
            "nextRunAt": null,
            "lastError": String::from_utf8_lossy(&output.stderr).trim().to_string(),
            "message": "Monitor run failed.",
        }),
        Err(err) => json!({
            "ok": false,
            "available": true,
            "running": false,
            "phase": "error",
            "pid": null,
            "lastRunAt": now,
            "nextRunAt": null,
            "lastError": err.to_string(),
            "message": "Unable to start monitor run.",
        }),
    };
    let _ = write_monitor_status_for_root(root, &status);
    status
}

fn run_backfill_recovery_for_root(root: &Path, spawn_process: bool) -> Value {
    if !spawn_process {
        let now = now_epoch_seconds();
        let status = json!({
            "ok": true,
            "available": true,
            "running": false,
            "phase": "recovery_completed",
            "pid": null,
            "lastRunAt": now,
            "lastRecoveryAt": now,
            "nextRunAt": null,
            "lastError": "",
            "message": "Backfill recovery completed.",
        });
        let _ = write_monitor_status_for_root(root, &status);
        return status;
    }
    let mut command = monitor_command_base(root);
    command.args(["-m", "src.xauusd_market_agent.cli", "--backfill-recovery"]);
    hide_child_window(&mut command);
    let output = command.output();
    let now = now_epoch_seconds();
    let status = match output {
        Ok(output) if output.status.success() => json!({
            "ok": true,
            "available": true,
            "running": false,
            "phase": "recovery_completed",
            "pid": null,
            "lastRunAt": now,
            "lastRecoveryAt": now,
            "nextRunAt": null,
            "lastError": "",
            "message": "Backfill recovery completed.",
        }),
        Ok(output) => json!({
            "ok": false,
            "available": true,
            "running": false,
            "phase": "recovery_failed",
            "pid": null,
            "lastRunAt": now,
            "lastRecoveryAt": now,
            "nextRunAt": null,
            "lastError": String::from_utf8_lossy(&output.stderr).trim().to_string(),
            "message": "Backfill recovery failed.",
        }),
        Err(err) => json!({
            "ok": false,
            "available": true,
            "running": false,
            "phase": "recovery_failed",
            "pid": null,
            "lastRunAt": now,
            "lastRecoveryAt": now,
            "nextRunAt": null,
            "lastError": err.to_string(),
            "message": "Unable to start backfill recovery.",
        }),
    };
    let _ = write_monitor_status_for_root(root, &status);
    status
}

fn resolve_market_agent_root() -> Option<PathBuf> {
    candidate_roots().into_iter().find(|root| {
        state_path_for_root(root).exists()
            || alerts_path_for_root(root).exists()
            || timeline_path_for_root(root).exists()
    })
}

fn read_json_file(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn read_live_quote_stream_status_for_root(root: &Path, probe_process: bool) -> Value {
    let status_path = live_quote_stream_status_path_for_root(root);
    let snapshot_path = live_quote_snapshot_path_for_root(root);
    let snapshot_fresh = live_quote_snapshot_is_fresh(root);
    let mut status = read_json_file(&status_path).unwrap_or_else(|| {
        json!({
            "ok": true,
            "running": snapshot_fresh,
            "phase": if snapshot_fresh { "running" } else { "stopped" },
            "pid": null,
            "message": if snapshot_fresh { "cTrader live quote stream is producing fresh snapshots." } else { "Live quote stream is stopped." },
            "snapshotPath": snapshot_path.display().to_string(),
        })
    });
    if snapshot_fresh {
        if let Some(object) = status.as_object_mut() {
            object.insert("ok".to_string(), Value::Bool(true));
            object.insert("running".to_string(), Value::Bool(true));
            object.insert("phase".to_string(), Value::String("running".to_string()));
            object.insert(
                "message".to_string(),
                Value::String(
                    "cTrader live quote stream is producing fresh snapshots.".to_string(),
                ),
            );
            object.insert(
                "snapshotPath".to_string(),
                Value::String(snapshot_path.display().to_string()),
            );
            object.insert("lastError".to_string(), Value::String(String::new()));
        }
        let _ = write_json_atomic(&status_path, &status);
        return status;
    }
    if !status
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let last_error = status
            .get("lastError")
            .and_then(Value::as_str)
            .unwrap_or("");
        let message = status.get("message").and_then(Value::as_str).unwrap_or("");
        let combined = format!("{last_error}\n{message}").to_ascii_lowercase();
        if combined.contains("process that is no longer running")
            || message.eq_ignore_ascii_case("Live quote stream stopped unexpectedly.")
            || combined.contains("saved live stream launcher process ended")
            || combined.contains("ctrader cli cbot streaming is disabled")
            || combined.contains("external algo host processes")
        {
            normalize_waiting_live_quote_status(&mut status, &snapshot_path);
            let _ = write_json_atomic(&status_path, &status);
            return status;
        }
    }
    let running = status
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let pid = status.get("pid").and_then(Value::as_i64).unwrap_or(0);
    if probe_process && running && pid > 0 && !is_process_running(pid) {
        normalize_waiting_live_quote_status(&mut status, &snapshot_path);
        let _ = write_json_atomic(&status_path, &status);
    }
    status
}

fn normalize_waiting_live_quote_status(status: &mut Value, snapshot_path: &Path) {
    if let Some(object) = status.as_object_mut() {
        object.insert("ok".to_string(), Value::Bool(true));
        object.insert("running".to_string(), Value::Bool(false));
        object.insert("phase".to_string(), Value::String("starting".to_string()));
        object.insert("pid".to_string(), Value::Null);
        object.insert("bridgePid".to_string(), Value::Null);
        object.insert(
            "message".to_string(),
            Value::String("cTrader live stream is not running yet.".to_string()),
        );
        object.insert("lastError".to_string(), Value::String(String::new()));
        object.insert(
            "snapshotPath".to_string(),
            Value::String(snapshot_path.display().to_string()),
        );
    }
}

fn stop_live_quote_stream_for_root(root: &Path, kill_process: bool) -> Value {
    let current = read_live_quote_stream_status_for_root(root, true);
    let pid = current.get("pid").and_then(Value::as_i64).unwrap_or(0);
    let mut last_error = String::new();
    if kill_process && pid > 0 {
        let result = if cfg!(target_os = "windows") {
            let mut command = Command::new("taskkill");
            command
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            hide_child_window(&mut command);
            command.output()
        } else {
            Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output()
        };
        if let Ok(output) = result {
            if !output.status.success() {
                last_error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            }
        }
    }
    let status = json!({
        "ok": last_error.is_empty(),
        "running": false,
        "phase": if last_error.is_empty() { "stopped" } else { "error" },
        "pid": null,
        "message": if last_error.is_empty() { "Live quote stream is stopped." } else { "Unable to stop live quote stream cleanly." },
        "lastError": last_error,
        "snapshotPath": live_quote_snapshot_path_for_root(root).display().to_string(),
    });
    let _ = write_json_atomic(&live_quote_stream_status_path_for_root(root), &status);
    status
}

fn start_live_quote_stream_for_root(root: &Path) -> Value {
    let current = read_live_quote_stream_status_for_root(root, false);
    if current
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "ok": true,
            "running": true,
            "phase": "running",
            "pid": current.get("pid").cloned().unwrap_or(Value::Null),
            "message": "Live quote stream is already running.",
            "snapshotPath": live_quote_snapshot_path_for_root(root).display().to_string(),
        });
    }
    let merged = merged_ctrader_provider_config(root, None);
    let account_id = merged
        .get("accountId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let ctid = merged
        .get("ctid")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let password = merged
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if account_id.is_empty() || ctid.is_empty() || password.is_empty() {
        let status = json!({
            "ok": false,
            "running": false,
            "phase": "credentials_required",
            "pid": null,
            "bridgePid": null,
            "message": "cTrader live stream requires saved account credentials.",
            "lastError": "cTrader live stream credentials are incomplete.",
            "snapshotPath": live_quote_snapshot_path_for_root(root).display().to_string(),
        });
        let _ = write_json_atomic(&live_quote_stream_status_path_for_root(root), &status);
        return status;
    }
    let snapshot_path = live_quote_snapshot_path_for_root(root);
    let status_path = live_quote_stream_status_path_for_root(root);
    let payload = json!({
        "accountId": account_id,
        "ctid": ctid,
        "password": password,
        "symbol": merged.get("symbol").and_then(Value::as_str).unwrap_or("XAUUSD"),
        "symbolId": merged.get("symbolId").cloned().unwrap_or(Value::Null),
        "snapshotPath": snapshot_path.display().to_string(),
        "statusPath": status_path.display().to_string(),
        "quoteStaleAfterSeconds": merged.get("quoteStaleAfterSeconds").and_then(Value::as_i64).unwrap_or(15),
        "cliExecutable": merged.get("cliExecutable").and_then(Value::as_str).unwrap_or("ctrader-cli"),
    });
    let mut child_command = live_quote_command_base(root);
    child_command
        .args([
            "-m",
            "src.xauusd_market_agent.providers.ctrader_live_stream",
            "start",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match child_command.spawn() {
        Ok(mut child) => {
            let pid = child.id() as i64;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(payload.to_string().as_bytes());
            }
            let status = json!({
                "ok": true,
                "running": true,
                "phase": "starting",
                "pid": pid,
                "bridgePid": null,
                "message": "Starting cTrader live stream bridge.",
                "lastError": "",
                "snapshotPath": snapshot_path.display().to_string(),
            });
            let _ = write_json_atomic(&status_path, &status);
            status
        }
        Err(err) => {
            let status = json!({
                "ok": false,
                "running": false,
                "phase": "error",
                "pid": null,
                "bridgePid": null,
                "message": "Unable to start cTrader live quote stream.",
                "lastError": err.to_string(),
                "snapshotPath": snapshot_path.display().to_string(),
            });
            let _ = write_json_atomic(&status_path, &status);
            status
        }
    }
}

fn ensure_live_quote_stream_for_root(root: &Path) -> Value {
    let current = read_live_quote_stream_status_for_root(root, true);
    if current
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return current;
    }
    start_live_quote_stream_for_root(root)
}

fn build_live_quote_response_at(root: &Path, now_utc: chrono::DateTime<chrono::Utc>) -> Value {
    let status = read_live_quote_stream_status_for_root(root, false);
    let snapshot_path = live_quote_snapshot_path_for_root(root);
    let snapshot = read_json_file(&snapshot_path);
    let snapshot_fresh = live_quote_snapshot_is_fresh_at(root, now_utc);
    let status_running = status
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let running = status_running && snapshot_fresh;
    let quote = snapshot.as_ref().and_then(|value| {
        if value.get("ok").and_then(Value::as_bool) == Some(false) {
            return None;
        }
        Some(json!({
            "symbol": value.get("symbol").and_then(Value::as_str).unwrap_or("XAUUSD"),
            "bid": value.get("bid").cloned().unwrap_or(Value::Null),
            "ask": value.get("ask").cloned().unwrap_or(Value::Null),
            "mid": value.get("mid").cloned().unwrap_or(Value::Null),
            "timestamp": value.get("timestamp").cloned().unwrap_or(Value::Null),
            "source": "cTrader",
            "source_type": "spot",
        }))
    });
    let (stale_phase, stale_message, stale_metadata) =
        stale_live_quote_context(snapshot.as_ref(), now_utc);
    let quote_available = quote.is_some();
    let phase = if running {
        status.get("phase").cloned().unwrap_or(json!("running"))
    } else if quote_available {
        json!(stale_phase)
    } else if status_running {
        status.get("phase").cloned().unwrap_or(json!("starting"))
    } else {
        status.get("phase").cloned().unwrap_or(json!("stopped"))
    };
    let message = if !running && quote_available {
        json!(stale_message.clone())
    } else if status_running {
        status
            .get("message")
            .cloned()
            .unwrap_or(json!("Starting cTrader live stream bridge."))
    } else {
        status
            .get("message")
            .cloned()
            .unwrap_or(json!("Live quote stream is stopped."))
    };
    let market_closed_context = !running && quote_available && stale_phase == "market_closed";
    let mut response_status = status.clone();
    if let Some(object) = response_status.as_object_mut() {
        if running || market_closed_context {
            object.insert("ok".to_string(), Value::Bool(true));
            object.insert("lastError".to_string(), Value::String(String::new()));
        }
        object.insert("running".to_string(), Value::Bool(running));
        object.insert("phase".to_string(), phase.clone());
        object.insert("message".to_string(), message.clone());
        if !running {
            object.insert("pid".to_string(), Value::Null);
        }
    }
    if response_status != status {
        let _ = write_json_atomic(
            &live_quote_stream_status_path_for_root(root),
            &response_status,
        );
    }
    let provider_health = snapshot.as_ref().map(|value| {
        let timestamp = value.get("timestamp").cloned().unwrap_or(Value::Null);
        json!({
            "provider_key": "xauusd",
            "source": "cTrader",
            "source_type": "spot",
            "data_mode": if running { "live_seen" } else { "stale" },
            "is_available": quote.is_some(),
            "is_stale": !running,
            "stale_reason": if running { "" } else { stale_message.as_str() },
            "error": value.get("error").and_then(Value::as_str).unwrap_or(""),
            "current_value": value.get("mid").cloned().unwrap_or(Value::Null),
            "previous_value": Value::Null,
            "change_value": Value::Null,
            "change_unit": "price",
            "data_timestamp": timestamp.clone(),
            "fetched_at": timestamp,
            "raw_source_id": value.get("symbol").cloned().unwrap_or(json!("XAUUSD")),
            "metadata": if running { json!({ "stale_classification": "fresh", "market_closed": false }) } else { stale_metadata.clone() },
        })
    });
    json!({
        "ok": response_status.get("ok").and_then(Value::as_bool).unwrap_or(true),
        "running": running,
        "phase": phase,
        "message": message,
        "lastError": response_status.get("lastError").cloned().unwrap_or(Value::Null),
        "snapshotPath": snapshot_path.display().to_string(),
        "status": response_status,
        "quote": quote.unwrap_or(Value::Null),
        "provider_health": provider_health.unwrap_or(Value::Null),
    })
}

fn build_live_quote_response(root: &Path) -> Value {
    build_live_quote_response_at(root, chrono::Utc::now())
}

fn read_alert_rows(path: &Path, limit: usize) -> Vec<Value> {
    let mut rows: Vec<Value> = fs::read_to_string(path)
        .ok()
        .map(|text| {
            text.lines()
                .filter_map(|line| {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        return None;
                    }
                    serde_json::from_str::<Value>(trimmed).ok()
                })
                .collect()
        })
        .unwrap_or_default();
    rows.sort_by(|a, b| {
        let av = a.get("time").and_then(|v| v.as_str()).unwrap_or("");
        let bv = b.get("time").and_then(|v| v.as_str()).unwrap_or("");
        bv.cmp(av)
    });
    if rows.len() > limit {
        rows.truncate(limit);
    }
    rows
}

fn open_timeline_db(root: &Path) -> Result<Connection, String> {
    let timeline_path = timeline_path_for_root(root);
    if !timeline_path.exists() {
        return Err("Market agent timeline store is not available yet.".to_string());
    }
    Connection::open(&timeline_path)
        .map_err(|err| format!("Unable to open market agent timeline store: {err}"))
}

fn table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
}

fn parse_json_value(raw: String) -> Option<Value> {
    serde_json::from_str::<Value>(&raw).ok()
}

fn query_payload_rows(
    connection: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<Value>, rusqlite::Error> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        row.get::<_, String>(0)
    })?;
    let mut payloads = Vec::new();
    for raw in rows.flatten() {
        if let Some(value) = parse_json_value(raw) {
            payloads.push(value);
        }
    }
    Ok(payloads)
}

fn query_latest_monitor_run(
    connection: &Connection,
) -> Result<Option<LatestMonitorRun>, rusqlite::Error> {
    if !table_exists(connection, "monitor_runs") {
        return Ok(None);
    }
    connection
        .query_row(
            "SELECT id, run_started_at, data_mode
             FROM monitor_runs
             ORDER BY julianday(run_started_at) DESC, run_started_at DESC, id DESC
             LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
}

fn read_provider_health_latest(
    connection: &Connection,
) -> Result<LatestPayloadRows, rusqlite::Error> {
    if !table_exists(connection, "provider_health") {
        return Ok((None, None, vec![]));
    }
    let Some((monitor_run_id, run_started_at, _data_mode)) = query_latest_monitor_run(connection)?
    else {
        return Ok((None, None, vec![]));
    };
    let mut statement = connection.prepare(
        "SELECT provider_key, payload_json FROM provider_health WHERE monitor_run_id = ?1 ORDER BY id",
    )?;
    let rows = statement.query_map([monitor_run_id], |row| {
        let provider_key: String = row.get(0)?;
        let payload_raw: String = row.get(1)?;
        Ok((provider_key, payload_raw))
    })?;
    let mut payloads = vec![];
    for row in rows.flatten() {
        let (provider_key, payload_raw) = row;
        if let Some(mut payload) = parse_json_value(payload_raw) {
            if let Some(object) = payload.as_object_mut() {
                object.insert("provider_key".to_string(), Value::String(provider_key));
                object.insert("monitor_run_id".to_string(), Value::from(monitor_run_id));
                object.insert(
                    "run_started_at".to_string(),
                    Value::String(run_started_at.clone()),
                );
            }
            payloads.push(payload);
        }
    }
    Ok((Some(monitor_run_id), Some(run_started_at), payloads))
}

fn merge_xauusd_provider_health(mut items: Vec<Value>, mut xauusd_health: Value) -> Vec<Value> {
    if let Some(object) = xauusd_health.as_object_mut() {
        object.insert(
            "provider_key".to_string(),
            Value::String("xauusd".to_string()),
        );
        object.insert(
            "runtime_source".to_string(),
            Value::String("ctrader_quote".to_string()),
        );
    }
    let mut replaced = false;
    for item in items.iter_mut() {
        let key = item
            .get("provider_key")
            .or_else(|| item.get("source"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if key == "xauusd" || key == "xauusd price" || key == "gc=f" {
            *item = xauusd_health.clone();
            replaced = true;
            break;
        }
    }
    if !replaced {
        items.insert(0, xauusd_health);
    }
    items
}

fn has_live_xauusd_provider_health(items: &[Value]) -> bool {
    items.iter().any(|item| {
        let key = item
            .get("provider_key")
            .or_else(|| item.get("source"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let source_type = item
            .get("source_type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let data_mode = item
            .get("data_mode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let is_available = item
            .get("is_available")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let is_stale = item
            .get("is_stale")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        (key == "xauusd" || key == "xauusd price" || key == "gc=f")
            && source_type == "spot"
            && data_mode == "live_seen"
            && is_available
            && !is_stale
    })
}

fn read_runtime_ctrader_xauusd_health(root: &Path) -> Option<Value> {
    build_live_quote_response(root)
        .get("provider_health")
        .cloned()
        .filter(|value| !value.is_null())
}

fn read_latest_provider_health_items_with_runtime_xauusd(root: &Path) -> Vec<Value> {
    let connection = match open_timeline_db(root) {
        Ok(connection) => connection,
        Err(_) => return vec![],
    };
    let items = match read_provider_health_latest(&connection) {
        Ok((_, _, items)) => items,
        Err(_) => vec![],
    };
    if has_live_xauusd_provider_health(&items) {
        items
    } else {
        read_runtime_ctrader_xauusd_health(root)
            .or_else(|| read_saved_ctrader_xauusd_health(root))
            .map(|health| merge_xauusd_provider_health(items.clone(), health))
            .unwrap_or(items)
    }
}

fn market_agent_runtime_inspect(root: &Path) -> Value {
    let live_quote = build_live_quote_response(root);
    let monitor_status = read_monitor_status_for_root_with_activity(root, true);
    let provider_health_items = read_latest_provider_health_items_with_runtime_xauusd(root);
    let xauusd_health = provider_health_items.iter().find(|item| {
        item.get("provider_key")
            .or_else(|| item.get("source"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("xauusd")
    });
    let ctrader_activity = monitor_status
        .get("activity")
        .and_then(|activity| activity.get("ctrader"))
        .cloned()
        .unwrap_or(Value::Null);
    let activity_jobs = ctrader_activity
        .get("jobs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let live_running = live_quote
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let live_mid = live_quote
        .get("quote")
        .and_then(|quote| quote.get("mid"))
        .and_then(Value::as_f64);
    let snapshot_timestamp = live_quote
        .get("quote")
        .and_then(|quote| quote.get("timestamp"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let activity_has_unavailable_live = activity_jobs.iter().any(|job| {
        let title = job
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let status = job
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        (title.contains("live quote request") || title.contains("spot freshness"))
            && (status.contains("unavailable") || status.contains("stale"))
    });
    let mut mismatches = vec![];
    if live_running && live_mid.is_some() && activity_has_unavailable_live {
        mismatches.push(json!({
            "code": "activity_still_marks_live_unavailable",
            "severity": "bad",
            "summary": "Runtime live quote is running, but Activity still shows the live ingest path as unavailable/stale.",
            "detail": "The exe is receiving a fresh XAUUSD quote, but the current Activity jobs still say live quote request or spot freshness is unavailable/stale."
        }));
    }
    if live_running
        && xauusd_health
            .and_then(|item| item.get("data_mode"))
            .and_then(Value::as_str)
            != Some("live_seen")
    {
        mismatches.push(json!({
            "code": "provider_health_not_live_seen",
            "severity": "bad",
            "summary": "Runtime live quote is running, but provider health is not marked as live_seen.",
            "detail": "The XAUUSD provider row should be spot/live_seen while the fresh cTrader stream is running."
        }));
    }
    let runtime_verdict = if live_running && live_mid.is_some() {
        "live_ok"
    } else if live_mid.is_some() {
        "snapshot_only"
    } else {
        "unavailable"
    };
    json!({
        "ok": true,
        "available": true,
        "root": root.display().to_string(),
        "runtime_verdict": runtime_verdict,
        "summary": if runtime_verdict == "live_ok" {
            "Runtime is receiving a fresh cTrader XAUUSD quote."
        } else if runtime_verdict == "snapshot_only" {
            "Runtime only has a saved XAUUSD snapshot right now."
        } else {
            "Runtime does not currently have a usable XAUUSD quote."
        },
        "live_quote": live_quote,
        "monitor_status": monitor_status,
        "ctrader_activity": ctrader_activity,
        "provider_health_items": provider_health_items,
        "xauusd_provider_health": xauusd_health.cloned().unwrap_or(Value::Null),
        "snapshot_timestamp": snapshot_timestamp,
        "live_mid": live_mid,
        "mismatches": mismatches,
    })
}

fn read_saved_ctrader_xauusd_health(root: &Path) -> Option<Value> {
    let config = merged_ctrader_provider_config(root, None);
    if !config
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }

    let now = chrono::Utc::now().to_rfc3339();
    let configured_snapshot_path = config
        .get("snapshotPath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("ctrader-live-quote.json"));
    let live_snapshot_path = live_quote_snapshot_path_for_root(root);
    let fallback_snapshot_path = if configured_snapshot_path == live_snapshot_path {
        None
    } else {
        Some(configured_snapshot_path)
    };
    let snapshot = read_json_file(&live_snapshot_path).or_else(|| {
        fallback_snapshot_path
            .as_ref()
            .and_then(|path| read_json_file(path))
    });
    let Some(snapshot) = snapshot else {
        return Some(json!({
            "source": "cTrader",
            "source_type": "spot",
            "data_mode": "unavailable",
            "is_available": false,
            "is_stale": true,
            "stale_reason": "No saved cTrader quote snapshot is available yet.",
            "error": "No saved cTrader quote snapshot is available yet.",
            "fetched_at": now,
            "data_timestamp": now,
        }));
    };

    let symbol = snapshot
        .get("symbol")
        .and_then(Value::as_str)
        .or_else(|| config.get("symbol").and_then(Value::as_str))
        .unwrap_or("XAUUSD");
    let timestamp = snapshot
        .get("timestamp")
        .or_else(|| snapshot.get("data_timestamp"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let current_value = snapshot
        .get("mid")
        .or_else(|| snapshot.get("close"))
        .or_else(|| snapshot.get("bid"))
        .and_then(Value::as_f64);
    Some(json!({
        "source": "cTrader",
        "source_type": "spot_snapshot",
        "data_mode": "snapshot",
        "is_available": current_value.is_some(),
        "is_stale": true,
        "stale_reason": "Loaded saved cTrader quote snapshot. Live refresh runs only during monitor/connect/test actions.",
        "error": "",
        "fetched_at": now,
        "data_timestamp": if timestamp.is_empty() { now.clone() } else { timestamp.to_string() },
        "current_value": current_value,
        "raw_source_id": snapshot
            .get("symbol_id")
            .or_else(|| snapshot.get("symbolId"))
            .cloned()
            .unwrap_or_else(|| Value::String(symbol.to_string())),
    }))
}

fn read_driver_attention_latest(
    connection: &Connection,
) -> Result<LatestPayloadRows, rusqlite::Error> {
    if !table_exists(connection, "driver_attention_states") {
        return Ok((None, None, vec![]));
    }
    let Some((monitor_run_id, run_started_at, _data_mode)) = query_latest_monitor_run(connection)?
    else {
        return Ok((None, None, vec![]));
    };
    let payloads = query_payload_rows(
        connection,
        "SELECT payload_json FROM driver_attention_states WHERE monitor_run_id = ?1 ORDER BY id",
        &[&monitor_run_id],
    )?
    .into_iter()
    .map(|mut payload| {
        if let Some(object) = payload.as_object_mut() {
            object.insert("monitor_run_id".to_string(), Value::from(monitor_run_id));
            object.insert(
                "run_started_at".to_string(),
                Value::String(run_started_at.clone()),
            );
        }
        payload
    })
    .collect();
    Ok((Some(monitor_run_id), Some(run_started_at), payloads))
}

fn read_range_payloads(
    connection: &Connection,
    table: &str,
    time_column: &str,
    start: &str,
    end: &str,
) -> Result<Vec<Value>, rusqlite::Error> {
    if !table_exists(connection, table) {
        return Ok(vec![]);
    }
    let sql = format!(
        "SELECT payload_json FROM {table} WHERE {time_column} >= ?1 AND {time_column} <= ?2 ORDER BY {time_column}, id"
    );
    query_payload_rows(connection, &sql, &[&start, &end])
}

fn news_value_text(item: &Value, key: &str) -> String {
    item.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn normalize_news_key_part(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn news_dedupe_key(item: &Value, fallback_index: usize) -> String {
    let title = normalize_news_key_part(
        &news_value_text(item, "title").if_empty_then(|| news_value_text(item, "summary_title")),
    );
    let link = normalize_news_key_part(&news_value_text(item, "link"));
    if title.is_empty() && link.is_empty() {
        return format!("row:{fallback_index}");
    }
    [
        title,
        normalize_news_key_part(&news_value_text(item, "source")),
        news_value_text(item, "published_at"),
        link,
    ]
    .join("|")
}

fn news_parse_timestamp_ms(value: &str) -> Option<i64> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .map(|parsed| parsed.timestamp_millis())
        .ok()
}

fn news_timestamp_score(value: &str) -> (i32, i64, String) {
    if let Some(timestamp) = news_parse_timestamp_ms(value) {
        return (1, timestamp, value.to_string());
    }
    (0, 0, value.to_string())
}

fn news_seen_at(item: &Value) -> String {
    for key in [
        "fetched_at",
        "first_seen_at",
        "backfilled_at",
        "published_at",
    ] {
        let value = news_value_text(item, key);
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

fn news_seen_count(item: &Value) -> i64 {
    if let Some(count) = item.get("seen_count").and_then(Value::as_i64) {
        return count.max(1);
    }
    if let Some(count) = item.get("duplicate_count").and_then(Value::as_i64) {
        return (count + 1).max(1);
    }
    1
}

fn news_item_preference(item: &Value) -> (i32, i32, i32, i64, String) {
    let has_summary = [
        "summary",
        "short_summary",
        "summary_source",
        "ai_summary_source",
    ]
    .iter()
    .any(|key| !news_value_text(item, key).is_empty());
    let review_status = news_value_text(item, "review_status").to_lowercase();
    let included = item.get("included").and_then(Value::as_bool) == Some(true)
        || review_status.contains("included");
    let seen_score = news_timestamp_score(&news_seen_at(item));
    (
        i32::from(has_summary),
        i32::from(included),
        seen_score.0,
        seen_score.1,
        seen_score.2,
    )
}

trait EmptyStringExt {
    fn if_empty_then<F: FnOnce() -> String>(self, fallback: F) -> String;
}

impl EmptyStringExt for String {
    fn if_empty_then<F: FnOnce() -> String>(self, fallback: F) -> String {
        if self.is_empty() {
            fallback()
        } else {
            self
        }
    }
}

fn dedupe_news_items(items: Vec<Value>) -> Vec<Value> {
    let mut groups: HashMap<String, Vec<Value>> = HashMap::new();
    let mut order = vec![];
    for (index, item) in items.into_iter().enumerate() {
        let key = news_dedupe_key(&item, index);
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(item);
    }

    let mut merged = vec![];
    for key in order {
        let Some(group) = groups.remove(&key) else {
            continue;
        };
        let mut best = group
            .iter()
            .max_by_key(|item| news_item_preference(item))
            .cloned()
            .unwrap_or(Value::Null);
        let seen_values: Vec<String> = group
            .iter()
            .map(news_seen_at)
            .filter(|value| !value.is_empty())
            .collect();
        if let Some(first_seen_at) = seen_values
            .iter()
            .min_by_key(|value| news_timestamp_score(value))
            .cloned()
        {
            if let Some(object) = best.as_object_mut() {
                object.insert("first_seen_at".to_string(), Value::String(first_seen_at));
            }
        }
        if let Some(last_seen_at) = seen_values
            .iter()
            .max_by_key(|value| news_timestamp_score(value))
            .cloned()
        {
            if let Some(object) = best.as_object_mut() {
                object.insert(
                    "last_seen_at".to_string(),
                    Value::String(last_seen_at.clone()),
                );
                object.insert("fetched_at".to_string(), Value::String(last_seen_at));
            }
        }
        let seen_count: i64 = group.iter().map(news_seen_count).sum::<i64>().max(1);
        if let Some(object) = best.as_object_mut() {
            object.insert("seen_count".to_string(), Value::from(seen_count));
            object.insert(
                "duplicate_count".to_string(),
                Value::from((seen_count - 1).max(0)),
            );
            let mut monitor_run_ids: Vec<i64> = group
                .iter()
                .filter_map(|item| item.get("monitor_run_id").and_then(Value::as_i64))
                .collect();
            monitor_run_ids.sort_unstable();
            monitor_run_ids.dedup();
            if !monitor_run_ids.is_empty() {
                object.insert("monitor_run_ids".to_string(), json!(monitor_run_ids));
            }
            let mut storage_row_ids: Vec<i64> = group
                .iter()
                .filter_map(|item| item.get("storage_row_id").and_then(Value::as_i64))
                .collect();
            storage_row_ids.sort_unstable();
            storage_row_ids.dedup();
            if !storage_row_ids.is_empty() {
                object.insert("storage_row_ids".to_string(), json!(storage_row_ids));
            }
        }
        merged.push(best);
    }
    merged
}

fn read_news_items(
    connection: &Connection,
    start: &str,
    end: &str,
) -> Result<Vec<Value>, rusqlite::Error> {
    if !table_exists(connection, "news_items") {
        return Ok(vec![]);
    }
    let mut statement = connection.prepare(
        "SELECT id, monitor_run_id, payload_json
         FROM news_items
         WHERE published_at >= ?1 AND published_at <= ?2
         ORDER BY published_at, id",
    )?;
    let rows = statement.query_map([start, end], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut items = vec![];
    for row in rows.flatten() {
        let (storage_row_id, monitor_run_id, payload_raw) = row;
        if let Some(mut payload) = parse_json_value(payload_raw) {
            if let Some(object) = payload.as_object_mut() {
                object
                    .entry("monitor_run_id")
                    .or_insert_with(|| Value::from(monitor_run_id));
                object
                    .entry("storage_row_id")
                    .or_insert_with(|| Value::from(storage_row_id));
            }
            items.push(payload);
        }
    }
    Ok(dedupe_news_items(items))
}

fn calendar_dirs_for_root(root: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![
        root.join("data").join("Economic_Calendar"),
        root.parent()
            .unwrap_or(root)
            .join("data")
            .join("Economic_Calendar"),
        config::working_root_dir(&config::load_config())
            .join("data")
            .join("Economic_Calendar"),
        config::install_dir().join("data").join("Economic_Calendar"),
    ];
    if let Some(repo_root) = repo_root_from_manifest() {
        candidates.push(repo_root.join("data").join("Economic_Calendar"));
        candidates.push(
            repo_root
                .join("user-data")
                .join("data")
                .join("Economic_Calendar"),
        );
    }
    let mut unique = vec![];
    for candidate in candidates {
        if candidate.exists()
            && !unique
                .iter()
                .any(|existing: &PathBuf| existing == &candidate)
        {
            unique.push(candidate);
        }
    }
    unique
}

fn calendar_row_text(row: &Value, key: &str) -> String {
    row.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn calendar_row_currency(row: &Value) -> String {
    let cur = calendar_row_text(row, "Cur.");
    if cur.is_empty() {
        calendar_row_text(row, "Currency")
    } else {
        cur
    }
}

fn read_calendar_context_from_files(root: &Path, start: &str, end: &str) -> Vec<Value> {
    let start_year = start.get(0..4).and_then(|value| value.parse::<i32>().ok());
    let end_year = end.get(0..4).and_then(|value| value.parse::<i32>().ok());
    let Some(start_year) = start_year else {
        return vec![];
    };
    let end_year = end_year.unwrap_or(start_year);
    let mut rows = vec![];
    for calendar_dir in calendar_dirs_for_root(root) {
        for year in start_year..=end_year {
            let path = calendar_dir
                .join(year.to_string())
                .join(format!("{year}_calendar.json"));
            let Some(Value::Array(items)) = read_json_file(&path) else {
                continue;
            };
            for item in items {
                let date = calendar_row_text(&item, "Date");
                let time = calendar_row_text(&item, "Time");
                let title = calendar_row_text(&item, "Event");
                if date.is_empty() || time.is_empty() || title.is_empty() {
                    continue;
                }
                let scheduled_at = if time.eq_ignore_ascii_case("all day") {
                    format!("{date}T00:00:00+08:00")
                } else if time.len() == 5 {
                    format!("{date}T{time}:00+08:00")
                } else {
                    continue;
                };
                if scheduled_at.as_str() < start || scheduled_at.as_str() > end {
                    continue;
                }
                let currency = calendar_row_currency(&item);
                let impact = calendar_row_text(&item, "Imp.");
                let source_detail = calendar_dir.display().to_string();
                rows.push(json!({
                    "scheduled_at": scheduled_at,
                    "source": "Economic Calendar",
                    "source_type": "existing_calendar",
                    "title": title,
                    "currency": currency,
                    "impact": impact,
                    "context_type": if impact.eq_ignore_ascii_case("holiday") {
                        "liquidity_context"
                    } else {
                        "calendar_context"
                    },
                    "actual": calendar_row_text(&item, "Actual"),
                    "forecast": calendar_row_text(&item, "Forecast"),
                    "previous": calendar_row_text(&item, "Previous"),
                    "relevance_reason": "Existing Economic Calendar event. Relevance requires evidence or AI review.",
                    "impact_direction_on_gold": "unknown",
                    "data_mode": "calendar_context",
                    "review_status": "unreviewed_context",
                    "storage_status": "read_from_existing_calendar",
                    "source_path": source_detail,
                }));
            }
        }
        if !rows.is_empty() {
            break;
        }
    }
    rows.sort_by(|a, b| {
        let at = a.get("scheduled_at").and_then(Value::as_str).unwrap_or("");
        let bt = b.get("scheduled_at").and_then(Value::as_str).unwrap_or("");
        at.cmp(bt)
    });
    rows
}

fn read_related_assets_map(
    connection: &Connection,
    start: &str,
    end: &str,
) -> Result<Value, rusqlite::Error> {
    let symbols = [
        "dxy", "us10y", "us2y", "wti", "brent", "vix", "spx", "nasdaq",
    ];
    let mut related = serde_json::Map::new();
    for symbol in symbols {
        let rows = if table_exists(connection, "related_asset_bars") {
            query_payload_rows(
                connection,
                "SELECT payload_json FROM related_asset_bars WHERE symbol = ?1 AND data_timestamp >= ?2 AND data_timestamp <= ?3 ORDER BY data_timestamp, id",
                &[&symbol, &start, &end],
            )?
        } else {
            vec![]
        };
        related.insert(symbol.to_string(), Value::Array(rows));
    }
    Ok(Value::Object(related))
}

fn read_timeline_items(
    connection: &Connection,
    start: &str,
    end: &str,
) -> Result<Vec<Value>, rusqlite::Error> {
    if !table_exists(connection, "timeline_events") {
        return Ok(vec![]);
    }
    let mut statement = connection.prepare(
        "SELECT monitor_run_id, event_time, event_type, label, payload_json FROM timeline_events WHERE event_time >= ?1 AND event_time <= ?2 ORDER BY event_time, id",
    )?;
    let rows = statement.query_map(params![start, end], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut items = vec![];
    for row in rows.flatten() {
        let (monitor_run_id, event_time, event_type, label, payload_raw) = row;
        if let Some(payload) = parse_json_value(payload_raw) {
            items.push(json!({
                "monitor_run_id": monitor_run_id,
                "event_time": event_time,
                "event_type": event_type,
                "label": label,
                "payload": payload,
            }));
        }
    }
    Ok(items)
}

fn normalized_market_agent_value(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase()
        .replace(|c: char| !c.is_ascii_alphanumeric(), "_")
        .trim_matches('_')
        .to_string()
}

fn timeline_payload(row: &Value) -> Option<&Value> {
    row.get("payload")
}

fn timeline_impact(row: &Value) -> Option<f64> {
    let payload = timeline_payload(row)?;
    payload
        .get("impact_percent")
        .and_then(Value::as_f64)
        .or_else(|| {
            payload
                .get("segment")
                .and_then(|segment| segment.get("move_percent"))
                .and_then(Value::as_f64)
        })
}

fn is_month_summary_event(row: &Value) -> bool {
    let event_type = normalized_market_agent_value(row.get("event_type"));
    let label = normalized_market_agent_value(row.get("label"));
    let payload = match timeline_payload(row) {
        Some(payload) => payload,
        None => return false,
    };
    let semantic_type = normalized_market_agent_value(payload.get("semantic_type"));
    let driver =
        normalized_market_agent_value(payload.get("main_driver").or_else(|| payload.get("driver")));
    if semantic_type.contains("recovery")
        || event_type.contains("recovery")
        || label.contains("backfill")
    {
        return false;
    }
    if driver.is_empty() || driver == "unknown" || driver == "no_state_change" {
        return false;
    }
    if matches!(semantic_type.as_str(), "breakout" | "reversal") {
        return true;
    }
    if event_type.contains("alert") {
        return timeline_impact(row)
            .map(|impact| impact.abs() >= 0.2)
            .unwrap_or(true);
    }
    if let Some(impact) = timeline_impact(row) {
        return impact.abs() >= 0.35;
    }
    false
}

fn build_month_summary_events(timeline_events: &[Value]) -> Vec<Value> {
    timeline_events
        .iter()
        .filter(|row| is_month_summary_event(row))
        .cloned()
        .collect()
}

fn read_state_transitions(
    connection: &Connection,
    start: &str,
    end: &str,
) -> Result<Vec<Value>, rusqlite::Error> {
    if !table_exists(connection, "state_transitions") || !table_exists(connection, "monitor_runs") {
        return Ok(vec![]);
    }
    let mut statement = connection.prepare(
        "SELECT state_transitions.monitor_run_id, monitor_runs.run_started_at, state_transitions.payload_json
         FROM state_transitions
         INNER JOIN monitor_runs ON monitor_runs.id = state_transitions.monitor_run_id
         WHERE monitor_runs.run_started_at >= ?1 AND monitor_runs.run_started_at <= ?2
         ORDER BY monitor_runs.run_started_at, state_transitions.id",
    )?;
    let rows = statement.query_map(params![start, end], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut items = vec![];
    for row in rows.flatten() {
        let (monitor_run_id, run_started_at, payload_raw) = row;
        if let Some(mut payload) = parse_json_value(payload_raw) {
            if let Some(object) = payload.as_object_mut() {
                object.insert("monitor_run_id".to_string(), Value::from(monitor_run_id));
                object.insert("run_started_at".to_string(), Value::String(run_started_at));
            }
            items.push(payload);
        }
    }
    Ok(items)
}

fn read_alerts(
    connection: &Connection,
    start: &str,
    end: &str,
    should_notify: Option<bool>,
) -> Result<Vec<Value>, rusqlite::Error> {
    if !table_exists(connection, "alerts") || !table_exists(connection, "monitor_runs") {
        return Ok(vec![]);
    }
    let mut items = vec![];
    if let Some(flag) = should_notify {
        let mut statement = connection.prepare(
            "SELECT alerts.monitor_run_id, monitor_runs.run_started_at, alerts.should_notify, alerts.payload_json
             FROM alerts
             INNER JOIN monitor_runs ON monitor_runs.id = alerts.monitor_run_id
             WHERE monitor_runs.run_started_at >= ?1 AND monitor_runs.run_started_at <= ?2
               AND alerts.should_notify = ?3
             ORDER BY monitor_runs.run_started_at, alerts.id",
        )?;
        let rows = statement.query_map(params![start, end, flag], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for row in rows.flatten() {
            let (monitor_run_id, run_started_at, should_notify_value, payload_raw) = row;
            if let Some(mut payload) = parse_json_value(payload_raw) {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("monitor_run_id".to_string(), Value::from(monitor_run_id));
                    object.insert("run_started_at".to_string(), Value::String(run_started_at));
                    object.insert(
                        "should_notify".to_string(),
                        Value::Bool(should_notify_value != 0),
                    );
                }
                items.push(payload);
            }
        }
    } else {
        let mut statement = connection.prepare(
            "SELECT alerts.monitor_run_id, monitor_runs.run_started_at, alerts.should_notify, alerts.payload_json
             FROM alerts
             INNER JOIN monitor_runs ON monitor_runs.id = alerts.monitor_run_id
             WHERE monitor_runs.run_started_at >= ?1 AND monitor_runs.run_started_at <= ?2
             ORDER BY monitor_runs.run_started_at, alerts.id",
        )?;
        let rows = statement.query_map(params![start, end], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for row in rows.flatten() {
            let (monitor_run_id, run_started_at, should_notify_value, payload_raw) = row;
            if let Some(mut payload) = parse_json_value(payload_raw) {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("monitor_run_id".to_string(), Value::from(monitor_run_id));
                    object.insert("run_started_at".to_string(), Value::String(run_started_at));
                    object.insert(
                        "should_notify".to_string(),
                        Value::Bool(should_notify_value != 0),
                    );
                }
                items.push(payload);
            }
        }
    }
    Ok(items)
}

fn read_evidence_for_run(
    connection: &Connection,
    monitor_run_id: i64,
) -> Result<Value, rusqlite::Error> {
    let evidence_packet = if table_exists(connection, "evidence_packets") {
        connection
            .query_row(
                "SELECT payload_json FROM evidence_packets WHERE monitor_run_id = ?1 ORDER BY id DESC LIMIT 1",
                [monitor_run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(parse_json_value)
    } else {
        None
    };

    let analysis_result = if table_exists(connection, "analysis_results") {
        connection
            .query_row(
                "SELECT payload_json FROM analysis_results WHERE monitor_run_id = ?1 ORDER BY id DESC LIMIT 1",
                [monitor_run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(parse_json_value)
    } else {
        None
    };

    let provider_health = if table_exists(connection, "provider_health") {
        let mut statement =
            connection.prepare("SELECT provider_key, payload_json FROM provider_health WHERE monitor_run_id = ?1 ORDER BY id")?;
        let rows = statement.query_map([monitor_run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut items = vec![];
        for row in rows.flatten() {
            let (provider_key, payload_raw) = row;
            if let Some(mut payload) = parse_json_value(payload_raw) {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("provider_key".to_string(), Value::String(provider_key));
                }
                items.push(payload);
            }
        }
        items
    } else {
        vec![]
    };

    let driver_attention_states = if table_exists(connection, "driver_attention_states") {
        query_payload_rows(
            connection,
            "SELECT payload_json FROM driver_attention_states WHERE monitor_run_id = ?1 ORDER BY id",
            &[&monitor_run_id],
        )?
    } else {
        vec![]
    };

    let alerts = if table_exists(connection, "alerts") {
        read_alerts_for_run(connection, monitor_run_id)?
    } else {
        vec![]
    };

    let state_transition = if table_exists(connection, "state_transitions") {
        connection
            .query_row(
                "SELECT payload_json FROM state_transitions WHERE monitor_run_id = ?1 ORDER BY id DESC LIMIT 1",
                [monitor_run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(parse_json_value)
    } else {
        None
    };

    let monitor_run = if table_exists(connection, "monitor_runs") {
        connection
            .query_row(
                "SELECT id, run_started_at, run_type, data_mode, backfill_required, no_news_found, alert_suppressed_reason
                 FROM monitor_runs WHERE id = ?1 LIMIT 1",
                [monitor_run_id],
                |row| {
                    Ok(json!({
                        "monitor_run_id": row.get::<_, i64>(0)?,
                        "run_started_at": row.get::<_, String>(1)?,
                        "run_type": row.get::<_, String>(2)?,
                        "data_mode": row.get::<_, String>(3)?,
                        "backfill_required": row.get::<_, i64>(4)? != 0,
                        "no_news_found": row.get::<_, i64>(5)? != 0,
                        "alert_suppressed_reason": row.get::<_, Option<String>>(6)?,
                    }))
                },
            )
            .optional()?
    } else {
        None
    };

    Ok(json!({
        "monitor_run": monitor_run,
        "evidence_packet": evidence_packet,
        "analysis_result": analysis_result,
        "provider_health": provider_health,
        "driver_attention_states": driver_attention_states,
        "alerts": alerts,
        "state_transition": state_transition,
    }))
}

fn read_alerts_for_run(
    connection: &Connection,
    monitor_run_id: i64,
) -> Result<Vec<Value>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT should_notify, payload_json FROM alerts WHERE monitor_run_id = ?1 ORDER BY id",
    )?;
    let rows = statement.query_map([monitor_run_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut items = vec![];
    for row in rows.flatten() {
        let (should_notify, payload_raw) = row;
        if let Some(mut payload) = parse_json_value(payload_raw) {
            if let Some(object) = payload.as_object_mut() {
                object.insert("should_notify".to_string(), Value::Bool(should_notify != 0));
            }
            items.push(payload);
        }
    }
    Ok(items)
}

fn build_unavailable_payload(message: &str, root: Option<&Path>) -> Value {
    let mut payload = json!({
        "ok": true,
        "available": false,
        "message": message,
    });
    if let Some(root) = root {
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "timeline_store_path".to_string(),
                Value::String(timeline_path_for_root(root).display().to_string()),
            );
        }
    }
    payload
}

fn empty_market_agent_replay_payload() -> Value {
    json!({
        "price_series": [],
        "related_assets": {},
        "news_items": [],
        "calendar_events": [],
        "driver_attention_timeline": [],
        "timeline_events": [],
        "state_transitions": [],
        "alerts": [],
        "suppressed_alerts": [],
    })
}

fn build_unavailable_replay_payload(message: &str, root: Option<&Path>) -> Value {
    let mut payload = build_unavailable_payload(message, root);
    if let Some(object) = payload.as_object_mut() {
        object.insert("replay".to_string(), empty_market_agent_replay_payload());
    }
    payload
}

pub(crate) fn read_market_agent_snapshot(root: &Path, limit: usize) -> Value {
    let state_path = state_path_for_root(root);
    let alerts_path = alerts_path_for_root(root);
    let timeline_path = timeline_path_for_root(root);
    let state = read_json_file(&state_path);
    let alerts = read_alert_rows(&alerts_path, limit);
    json!({
        "ok": true,
        "available": state.is_some() || !alerts.is_empty() || timeline_path.exists(),
        "state_path": state_path.display().to_string(),
        "alerts_path": alerts_path.display().to_string(),
        "timeline_store_path": timeline_path.display().to_string(),
        "timeline_available": timeline_path.exists(),
        "state": state.unwrap_or(Value::Null),
        "alerts": alerts,
    })
}

#[tauri::command]
pub fn get_market_agent_snapshot(payload: Value) -> Value {
    run_logged_market_agent_command("get_market_agent_snapshot", &payload, || {
        let limit = payload
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(5)
            .clamp(1, 50);
        let Some(root) = resolve_market_agent_root() else {
            return json!({
                "ok": true,
                "available": false,
                "state": Value::Null,
                "alerts": [],
                "message": "Market agent artifacts are not available yet."
            });
        };
        read_market_agent_snapshot(&root, limit)
    })
}

#[tauri::command]
pub fn get_market_agent_provider_health(_payload: Value) -> Value {
    run_logged_market_agent_command("get_market_agent_provider_health", &Value::Null, || {
        let Some(root) = resolve_market_agent_root() else {
            return build_unavailable_payload(
                "Market agent artifacts are not available yet.",
                None,
            );
        };
        let timeline_path = timeline_path_for_root(&root);
        let connection = match open_timeline_db(&root) {
            Ok(connection) => connection,
            Err(message) => return build_unavailable_payload(&message, Some(&root)),
        };
        match read_provider_health_latest(&connection) {
            Ok((monitor_run_id, run_started_at, items)) => {
                let items = if has_live_xauusd_provider_health(&items) {
                    items
                } else {
                    read_runtime_ctrader_xauusd_health(&root)
                        .or_else(|| read_saved_ctrader_xauusd_health(&root))
                        .map(|health| merge_xauusd_provider_health(items.clone(), health))
                        .unwrap_or(items)
                };
                json!({
                    "ok": true,
                    "available": timeline_path.exists(),
                    "timeline_store_path": timeline_path.display().to_string(),
                    "monitor_run_id": monitor_run_id,
                    "run_started_at": run_started_at,
                    "items": items,
                })
            }
            Err(err) => build_unavailable_payload(
                &format!("Unable to read provider health: {err}"),
                Some(&root),
            ),
        }
    })
}

#[tauri::command]
pub fn inspect_market_agent_runtime(_payload: Value) -> Value {
    run_logged_market_agent_command("inspect_market_agent_runtime", &Value::Null, || {
        let Some(root) = resolve_market_agent_root() else {
            return build_unavailable_payload(
                "Market agent artifacts are not available yet.",
                None,
            );
        };
        market_agent_runtime_inspect(&root)
    })
}

#[tauri::command]
pub fn get_market_agent_driver_attention(_payload: Value) -> Value {
    run_logged_market_agent_command("get_market_agent_driver_attention", &Value::Null, || {
        let Some(root) = resolve_market_agent_root() else {
            return build_unavailable_payload(
                "Market agent artifacts are not available yet.",
                None,
            );
        };
        let timeline_path = timeline_path_for_root(&root);
        let connection = match open_timeline_db(&root) {
            Ok(connection) => connection,
            Err(message) => return build_unavailable_payload(&message, Some(&root)),
        };
        match read_driver_attention_latest(&connection) {
            Ok((monitor_run_id, run_started_at, states)) => json!({
                "ok": true,
                "available": timeline_path.exists(),
                "timeline_store_path": timeline_path.display().to_string(),
                "monitor_run_id": monitor_run_id,
                "run_started_at": run_started_at,
                "states": states,
            }),
            Err(err) => build_unavailable_payload(
                &format!("Unable to read driver attention: {err}"),
                Some(&root),
            ),
        }
    })
}

#[tauri::command]
pub fn get_market_agent_timeline(payload: Value) -> Value {
    let start = payload.get("start").and_then(|v| v.as_str()).unwrap_or("");
    let end = payload.get("end").and_then(|v| v.as_str()).unwrap_or("");
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let timeline_path = timeline_path_for_root(&root);
    let connection = match open_timeline_db(&root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_payload(&message, Some(&root)),
    };
    match read_timeline_items(&connection, start, end) {
        Ok(items) => json!({
            "ok": true,
            "available": timeline_path.exists(),
            "timeline_store_path": timeline_path.display().to_string(),
            "start": start,
            "end": end,
            "items": items,
        }),
        Err(err) => build_unavailable_payload(
            &format!("Unable to read market agent timeline: {err}"),
            Some(&root),
        ),
    }
}

#[tauri::command]
pub fn get_market_agent_state_transitions(payload: Value) -> Value {
    let start = payload.get("start").and_then(|v| v.as_str()).unwrap_or("");
    let end = payload.get("end").and_then(|v| v.as_str()).unwrap_or("");
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let timeline_path = timeline_path_for_root(&root);
    let connection = match open_timeline_db(&root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_payload(&message, Some(&root)),
    };
    match read_state_transitions(&connection, start, end) {
        Ok(items) => json!({
            "ok": true,
            "available": timeline_path.exists(),
            "timeline_store_path": timeline_path.display().to_string(),
            "start": start,
            "end": end,
            "items": items,
        }),
        Err(err) => build_unavailable_payload(
            &format!("Unable to read state transitions: {err}"),
            Some(&root),
        ),
    }
}

#[tauri::command]
pub fn get_market_agent_suppressed_alerts(payload: Value) -> Value {
    let start = payload.get("start").and_then(|v| v.as_str()).unwrap_or("");
    let end = payload.get("end").and_then(|v| v.as_str()).unwrap_or("");
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let timeline_path = timeline_path_for_root(&root);
    let connection = match open_timeline_db(&root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_payload(&message, Some(&root)),
    };
    match read_alerts(&connection, start, end, Some(false)) {
        Ok(items) => json!({
            "ok": true,
            "available": timeline_path.exists(),
            "timeline_store_path": timeline_path.display().to_string(),
            "start": start,
            "end": end,
            "items": items,
        }),
        Err(err) => build_unavailable_payload(
            &format!("Unable to read suppressed alerts: {err}"),
            Some(&root),
        ),
    }
}

#[tauri::command]
pub fn get_market_agent_evidence_for_run(payload: Value) -> Value {
    run_logged_market_agent_command("get_market_agent_evidence_for_run", &payload, || {
        let monitor_run_id = payload
            .get("monitorRunId")
            .or_else(|| payload.get("monitor_run_id"))
            .and_then(|v| v.as_i64())
            .unwrap_or_default();
        let Some(root) = resolve_market_agent_root() else {
            return build_unavailable_payload(
                "Market agent artifacts are not available yet.",
                None,
            );
        };
        let timeline_path = timeline_path_for_root(&root);
        let connection = match open_timeline_db(&root) {
            Ok(connection) => connection,
            Err(message) => return build_unavailable_payload(&message, Some(&root)),
        };
        match read_evidence_for_run(&connection, monitor_run_id) {
            Ok(payload) => json!({
                "ok": true,
                "available": timeline_path.exists(),
                "timeline_store_path": timeline_path.display().to_string(),
                "monitor_run_id": monitor_run_id,
                "payload": payload,
            }),
            Err(err) => build_unavailable_payload(
                &format!("Unable to read evidence for run: {err}"),
                Some(&root),
            ),
        }
    })
}

#[tauri::command]
pub fn get_market_agent_replay(payload: Value) -> Value {
    run_logged_market_agent_command("get_market_agent_replay", &payload, || {
        let Some(root) = resolve_market_agent_root() else {
            return build_unavailable_payload(
                "Market agent artifacts are not available yet.",
                None,
            );
        };
        let start = payload.get("start").and_then(|v| v.as_str()).unwrap_or("");
        let end = payload.get("end").and_then(|v| v.as_str()).unwrap_or("");
        read_market_agent_replay(&root, start, end)
    })
}

#[tauri::command]
pub fn get_market_agent_provider_config(_payload: Value) -> Value {
    masked_ctrader_provider_config(&market_agent_runtime_root())
}

#[tauri::command]
pub fn save_market_agent_provider_config(payload: Value) -> Value {
    match save_ctrader_provider_config(&market_agent_runtime_root(), &payload) {
        Ok(value) => value,
        Err(err) => json!({
            "ok": false,
            "available": false,
            "message": err,
        }),
    }
}

#[tauri::command]
pub fn get_market_agent_telegram_config(_payload: Value) -> Value {
    masked_telegram_config_for_root(&market_agent_runtime_root())
}

#[tauri::command]
pub fn get_market_agent_llm_config(_payload: Value) -> Value {
    masked_llm_config_for_root(&market_agent_runtime_root())
}

#[tauri::command]
pub fn save_market_agent_telegram_config(payload: Value) -> Value {
    match save_telegram_config_for_root(&market_agent_runtime_root(), &payload) {
        Ok(value) => value,
        Err(err) => json!({
            "ok": false,
            "available": false,
            "message": err,
        }),
    }
}

#[tauri::command]
pub fn save_market_agent_llm_config(payload: Value) -> Value {
    match save_llm_config_for_root(&market_agent_runtime_root(), &payload) {
        Ok(value) => value,
        Err(err) => json!({
            "ok": false,
            "available": false,
            "message": err,
        }),
    }
}

#[tauri::command]
pub fn test_market_agent_telegram(payload: Value) -> Value {
    test_telegram_for_root(&market_agent_runtime_root(), &payload)
}

#[tauri::command]
pub fn test_market_agent_llm_connection(payload: Value) -> Value {
    test_llm_for_root(&market_agent_runtime_root(), &payload, "connection")
}

#[tauri::command]
pub fn test_market_agent_llm_json_response(payload: Value) -> Value {
    test_llm_for_root(&market_agent_runtime_root(), &payload, "json")
}

#[tauri::command]
pub fn detect_system_profile(_payload: Value) -> Value {
    detect_system_profile_value()
}

#[tauri::command]
pub fn check_ollama_installed(_payload: Value) -> Value {
    check_ollama_installed_value()
}

#[tauri::command]
pub fn check_ollama_running(payload: Value) -> Value {
    check_ollama_running_value(&endpoint_from_payload(&payload))
}

#[tauri::command]
pub fn list_ollama_models(payload: Value) -> Value {
    list_ollama_models_value(&endpoint_from_payload(&payload))
}

#[tauri::command]
pub fn recommend_local_model(payload: Value) -> Value {
    let profile = payload
        .get("system")
        .or_else(|| payload.get("profile"))
        .cloned()
        .unwrap_or_else(detect_system_profile_value);
    recommend_local_model_from_profile(&profile)
}

#[tauri::command]
pub fn detect_local_ai_setup(payload: Value) -> Value {
    detect_local_ai_setup_value(&market_agent_runtime_root(), &payload)
}

#[tauri::command]
pub fn pull_ollama_model(app: tauri::AppHandle, payload: Value) -> Value {
    let model = model_from_payload(&payload);
    let starting = json!({
        "model": model,
        "status": "preparing runtime",
        "message": "Preparing Local AI runtime...",
        "completedBytes": Value::Null,
        "totalBytes": Value::Null,
        "percent": Value::Null,
        "done": false,
    });
    let _ = app.emit("market-agent:ollama-pull-progress", starting);
    std::thread::spawn(move || {
        let _ = run_ollama_pull(&app, &payload);
    });
    json!({
        "ok": true,
        "status": "download_started",
        "model": model,
        "message": "Local AI model download is running in the background.",
        "done": false
    })
}

#[tauri::command]
pub fn cancel_model_download(app: tauri::AppHandle, payload: Value) -> Value {
    CANCEL_OLLAMA_PULL.store(true, Ordering::SeqCst);
    let model = model_from_payload(&payload);
    let cancelled = ollama_pull_cancelled_value(&model);
    let _ = app.emit("market-agent:ollama-pull-progress", cancelled.clone());
    json!({
        "ok": true,
        "status": "cancelled",
        "model": model,
        "message": "Model download cancelled.",
        "done": true
    })
}

#[tauri::command]
pub fn test_llm_json(payload: Value) -> Value {
    test_llm_for_root(&market_agent_runtime_root(), &payload, "json")
}

#[tauri::command]
pub fn benchmark_llm(payload: Value) -> Value {
    benchmark_llm_value(&payload)
}

#[tauri::command]
pub fn apply_llm_fallback_policy(payload: Value) -> Value {
    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("qwen3.5:4b");
    let status = payload
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("failed");
    let elapsed_ms = payload.get("elapsedMs").and_then(Value::as_i64);
    apply_llm_fallback_policy_for_result(model, status, elapsed_ms)
}

#[tauri::command]
pub fn clear_ctrader_config(_payload: Value) -> Value {
    match clear_ctrader_provider_config(&market_agent_runtime_root()) {
        Ok(value) => value,
        Err(err) => json!({
            "ok": false,
            "available": false,
            "message": err,
        }),
    }
}

#[tauri::command]
pub fn test_ctrader_connection(payload: Value) -> Value {
    run_ctrader_bridge(&market_agent_runtime_root(), "test-connection", &payload)
}

#[tauri::command]
pub fn resolve_ctrader_symbol(payload: Value) -> Value {
    run_ctrader_bridge(&market_agent_runtime_root(), "resolve-symbol", &payload)
}

#[tauri::command]
pub fn get_ctrader_quote_test(payload: Value) -> Value {
    run_ctrader_bridge(&market_agent_runtime_root(), "quote", &payload)
}

#[tauri::command]
pub fn ensure_market_agent_live_quote_stream(_payload: Value) -> Value {
    run_logged_market_agent_command(
        "ensure_market_agent_live_quote_stream",
        &Value::Null,
        || ensure_live_quote_stream_for_root(&market_agent_runtime_root()),
    )
}

#[tauri::command]
pub fn get_market_agent_live_quote(_payload: Value) -> Value {
    run_market_agent_command(|| build_live_quote_response(&market_agent_runtime_root()))
}

#[tauri::command]
pub fn stop_market_agent_live_quote_stream(_payload: Value) -> Value {
    run_logged_market_agent_command("stop_market_agent_live_quote_stream", &Value::Null, || {
        stop_live_quote_stream_for_root(&market_agent_runtime_root(), true)
    })
}

fn start_ctrader_connect_for_root(root: &Path, payload: Value) -> Value {
    let mut merged = merged_ctrader_provider_config(root, Some(&payload));
    merged["enabled"] = Value::Bool(true);
    merged["snapshotPath"] = Value::String(
        live_quote_snapshot_path_for_root(root)
            .display()
            .to_string(),
    );
    match save_ctrader_provider_config(root, &json!({"ctrader": merged})) {
        Ok(_) => {
            let stream_result = start_live_quote_stream_for_root(root);
            let live_quote = build_live_quote_response(root);
            let quote = live_quote.get("quote").cloned().unwrap_or(Value::Null);
            let provider_health = read_runtime_ctrader_xauusd_health(root)
                .or_else(|| read_saved_ctrader_xauusd_health(root))
                .unwrap_or(Value::Null);
            let live_ready = live_quote
                .get("running")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && !quote.is_null();
            if live_ready {
                return json!({
                    "ok": true,
                    "status": "live_feed_ready",
                    "message": "cTrader settings were saved and a fresh live XAUUSD snapshot is available.",
                    "quote": quote,
                    "provider_health": provider_health,
                    "live_stream": stream_result,
                    "ctrader": masked_ctrader_provider_config(root).get("ctrader").cloned().unwrap_or(Value::Null),
                });
            }
            json!({
                "ok": true,
                "status": "starting_live_stream",
                "message": "cTrader settings were saved. The live stream is starting and waiting for the first fresh XAUUSD snapshot.",
                "quote": quote,
                "provider_health": provider_health,
                "live_stream": stream_result,
                "ctrader": masked_ctrader_provider_config(root).get("ctrader").cloned().unwrap_or(Value::Null),
            })
        }
        Err(err) => json!({
            "ok": false,
            "status": "save_failed",
            "error": err,
        }),
    }
}

#[tauri::command]
pub fn start_ctrader_connect(payload: Value) -> Value {
    start_ctrader_connect_for_root(&market_agent_runtime_root(), payload)
}

#[tauri::command]
pub fn test_ctrader_backfill(payload: Value) -> Value {
    test_ctrader_backfill_for_root(&market_agent_runtime_root(), &payload)
}

#[tauri::command]
pub fn get_market_agent_monitor_status(payload: Value) -> Value {
    run_logged_market_agent_command("get_market_agent_monitor_status", &payload, || {
        let include_activity = payload
            .get("includeActivity")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        read_monitor_status_for_root_with_activity(&market_agent_runtime_root(), include_activity)
    })
}

#[tauri::command]
pub fn run_market_agent_monitor_once(_payload: Value) -> Value {
    run_logged_market_agent_command("run_market_agent_monitor_once", &Value::Null, || {
        run_monitor_once_for_root(&market_agent_runtime_root())
    })
}

#[tauri::command]
pub fn run_market_agent_backfill_recovery(_payload: Value) -> Value {
    run_logged_market_agent_command("run_market_agent_backfill_recovery", &Value::Null, || {
        run_backfill_recovery_for_root(&market_agent_runtime_root(), true)
    })
}

#[tauri::command]
pub fn start_market_agent_monitor_loop(payload: Value) -> Value {
    run_logged_market_agent_command("start_market_agent_monitor_loop", &payload, || {
        let interval_seconds = payload
            .get("intervalSeconds")
            .and_then(Value::as_i64)
            .unwrap_or(60)
            .max(10);
        start_monitor_loop_for_root(&market_agent_runtime_root(), interval_seconds, true)
    })
}

#[tauri::command]
pub fn stop_market_agent_monitor_loop(_payload: Value) -> Value {
    run_logged_market_agent_command("stop_market_agent_monitor_loop", &Value::Null, || {
        stop_monitor_loop_for_root(&market_agent_runtime_root(), true)
    })
}

pub(crate) fn read_market_agent_replay(root: &Path, start: &str, end: &str) -> Value {
    let timeline_path = timeline_path_for_root(root);
    let connection = match open_timeline_db(root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_replay_payload(&message, Some(root)),
    };

    let price_series = match read_range_payloads(
        &connection,
        "market_price_bars",
        "data_timestamp",
        start,
        end,
    ) {
        Ok(rows) => rows,
        Err(err) => {
            return build_unavailable_replay_payload(
                &format!("Unable to read market replay price series: {err}"),
                Some(root),
            )
        }
    };
    let related_assets = match read_related_assets_map(&connection, start, end) {
        Ok(rows) => rows,
        Err(err) => {
            return build_unavailable_replay_payload(
                &format!("Unable to read related asset replay series: {err}"),
                Some(root),
            )
        }
    };
    let news_items = read_news_items(&connection, start, end).unwrap_or_default();
    let mut calendar_events = read_calendar_context_from_files(root, start, end);
    if calendar_events.is_empty() {
        calendar_events =
            read_range_payloads(&connection, "calendar_events", "scheduled_at", start, end)
                .unwrap_or_default();
    }
    let driver_attention_timeline = if table_exists(&connection, "driver_attention_states")
        && table_exists(&connection, "monitor_runs")
    {
        query_payload_rows(
            &connection,
            "SELECT driver_attention_states.payload_json
             FROM driver_attention_states
             INNER JOIN monitor_runs ON monitor_runs.id = driver_attention_states.monitor_run_id
             WHERE monitor_runs.run_started_at >= ?1 AND monitor_runs.run_started_at <= ?2
             ORDER BY monitor_runs.run_started_at, driver_attention_states.id",
            &[&start, &end],
        )
        .unwrap_or_default()
    } else {
        vec![]
    };
    let timeline_events = read_timeline_items(&connection, start, end).unwrap_or_default();
    let month_summary_events = build_month_summary_events(&timeline_events);
    let state_transitions = read_state_transitions(&connection, start, end).unwrap_or_default();
    let alerts = read_alerts(&connection, start, end, Some(true)).unwrap_or_default();
    let suppressed_alerts = read_alerts(&connection, start, end, Some(false)).unwrap_or_default();

    json!({
        "ok": true,
        "available": timeline_path.exists(),
        "timeline_store_path": timeline_path.display().to_string(),
        "start": start,
        "end": end,
        "replay": {
            "price_series": price_series,
            "related_assets": related_assets,
            "news_items": news_items,
            "calendar_events": calendar_events,
            "driver_attention_timeline": driver_attention_timeline,
            "timeline_events": timeline_events,
            "month_summary_events": month_summary_events,
            "state_transitions": state_transitions,
            "alerts": alerts,
            "suppressed_alerts": suppressed_alerts,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{
        apply_llm_fallback_policy_for_result, build_live_quote_response,
        build_live_quote_response_at, clear_ctrader_provider_config, ctrader_config_path_for_root,
        ctrader_env_for_root, live_quote_snapshot_path_for_root,
        live_quote_stream_status_path_for_root, llm_config_path_for_root, llm_env_for_root,
        mask_secret, masked_ctrader_provider_config, masked_llm_config_for_root,
        masked_telegram_config_for_root, merge_xauusd_provider_health, monitor_command_base,
        monitor_python_program, monitor_status_path_for_root, normalize_ctrader_bridge_error,
        normalize_pull_progress_line, read_json_file, read_json_object,
        read_live_quote_stream_status_for_root, read_market_agent_replay,
        read_market_agent_snapshot, read_monitor_status_for_root,
        read_monitor_status_for_root_with_activity, read_provider_health_latest,
        read_runtime_ctrader_xauusd_health, read_saved_ctrader_xauusd_health,
        recommend_local_model_from_profile, run_backfill_recovery_for_root, run_ctrader_bridge,
        save_ctrader_provider_config, save_llm_config_for_root, save_telegram_config_for_root,
        should_reuse_running_monitor, start_ctrader_connect_for_root,
        start_live_quote_stream_for_root, start_monitor_loop_for_root, stop_monitor_loop_for_root,
        telegram_config_path_for_root, telegram_env_for_root, test_telegram_for_root,
        timeline_path_for_root, write_json_atomic, write_monitor_status_for_root,
        DEFAULT_LLM_TEMPERATURE, DEFAULT_LLM_TIMEOUT_SECONDS, DEFAULT_OLLAMA_ENDPOINT,
    };
    use chrono::Utc;
    use filetime::{set_file_mtime, FileTime};
    use rusqlite::{params, Connection};
    use serde_json::{json, Value};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};

    fn unique_temp_dir(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "xauusd-market-agent-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[test]
    fn ctrader_bridge_error_unwraps_nested_adapter_json() {
        let raw = json!({
            "ok": false,
            "error": "{\"error\":\"The installed cTrader CLI supports account and symbol checks, but does not expose live quotes through this adapter.\",\"ok\":false}",
            "payload": {}
        });

        let normalized = normalize_ctrader_bridge_error(raw);

        assert_eq!(normalized.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            normalized.get("error").and_then(Value::as_str),
            Some("The installed cTrader CLI supports account and symbol checks, but does not expose live quotes through this adapter.")
        );
        assert!(normalized.get("payload").is_some());
    }

    fn seed_timeline_db(path: &PathBuf) {
        let connection = Connection::open(path).expect("open sqlite");
        connection
            .execute_batch(
                "
                CREATE TABLE monitor_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_started_at TEXT NOT NULL,
                    run_type TEXT NOT NULL,
                    data_mode TEXT NOT NULL,
                    backfill_required INTEGER NOT NULL DEFAULT 0,
                    last_successful_run_at TEXT,
                    no_news_found INTEGER NOT NULL DEFAULT 0,
                    alert_suppressed_reason TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE provider_health (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    provider_key TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE market_price_bars (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    symbol TEXT NOT NULL,
                    data_timestamp TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE related_asset_bars (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    symbol TEXT NOT NULL,
                    data_timestamp TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE news_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    published_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE calendar_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    scheduled_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE driver_attention_states (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE evidence_packets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE analysis_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    should_notify INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE state_transitions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE timeline_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    event_time TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    label TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                ",
            )
            .expect("seed schema");
        connection
            .execute(
                "INSERT INTO monitor_runs (id, run_started_at, run_type, data_mode, backfill_required, no_news_found, alert_suppressed_reason, created_at)
                 VALUES (1, '2026-05-19T08:00:00+08:00', 'recovery', 'backfilled', 1, 0, 'cooldown', '2026-05-19T08:00:00+08:00')",
                [],
            )
            .expect("insert run");
        connection
            .execute(
                "INSERT INTO provider_health (monitor_run_id, provider_key, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    "xauusd",
                    json!({
                        "source": "Yahoo Finance",
                        "source_type": "futures_proxy",
                        "data_mode": "proxy",
                        "is_available": true,
                        "is_stale": false,
                        "data_timestamp": "2026-05-19T08:00:00+08:00",
                        "fetched_at": "2026-05-19T08:00:05+08:00"
                    })
                    .to_string()
                ],
            )
            .expect("insert provider health");
        connection
            .execute(
                "INSERT INTO market_price_bars (monitor_run_id, symbol, data_timestamp, payload_json) VALUES (?1, ?2, ?3, ?4)",
                params![
                    1,
                    "GC=F",
                    "2026-05-19T08:00:00+08:00",
                    json!({
                        "symbol": "GC=F",
                        "data_timestamp": "2026-05-19T08:00:00+08:00",
                        "close_price": 4500.2,
                        "source_type": "futures_proxy",
                        "data_mode": "proxy"
                    }).to_string()
                ],
            )
            .expect("insert price row");
        connection
            .execute(
                "INSERT INTO related_asset_bars (monitor_run_id, symbol, data_timestamp, payload_json) VALUES (?1, ?2, ?3, ?4)",
                params![
                    1,
                    "dxy",
                    "2026-05-19T08:00:00+08:00",
                    json!({
                        "symbol": "dxy",
                        "data_timestamp": "2026-05-19T08:00:00+08:00",
                        "change_15m": 0.22,
                        "source_type": "proxy",
                        "data_mode": "live_seen"
                    }).to_string()
                ],
            )
            .expect("insert related row");
        connection
            .execute(
                "INSERT INTO news_items (monitor_run_id, published_at, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    "2026-05-19T07:55:00+08:00",
                    json!({
                        "title": "Fed headline",
                        "published_at": "2026-05-19T07:55:00+08:00",
                        "included": true
                    }).to_string()
                ],
            )
            .expect("insert news row");
        connection
            .execute(
                "INSERT INTO calendar_events (monitor_run_id, scheduled_at, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    "2026-05-19T08:15:00+08:00",
                    json!({
                        "title": "CPI",
                        "scheduled_at": "2026-05-19T08:15:00+08:00"
                    }).to_string()
                ],
            )
            .expect("insert calendar row");
        connection
            .execute(
                "INSERT INTO driver_attention_states (monitor_run_id, payload_json) VALUES (?1, ?2)",
                params![
                    1,
                    json!({
                        "driver_id": "yields",
                        "current_state": "active",
                        "priority": "core_structural",
                        "data_mode": "backfilled"
                    }).to_string()
                ],
            )
            .expect("insert driver state");
        connection
            .execute(
                "INSERT INTO evidence_packets (monitor_run_id, payload_json) VALUES (?1, ?2)",
                params![
                    1,
                    json!({
                        "allowed_candidate_drivers": ["yields"],
                        "blocked_drivers": {"fed_rates": "no headline"},
                        "provider_health": {"xauusd": {"source_type": "futures_proxy"}},
                    })
                    .to_string()
                ],
            )
            .expect("insert evidence");
        connection
            .execute(
                "INSERT INTO analysis_results (monitor_run_id, payload_json) VALUES (?1, ?2)",
                params![
                    1,
                    json!({
                        "main_driver": "yields",
                        "cause_status": "likely",
                        "confidence": "medium"
                    })
                    .to_string()
                ],
            )
            .expect("insert analysis");
        connection
            .execute(
                "INSERT INTO alerts (monitor_run_id, should_notify, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    1,
                    json!({
                        "time": "2026-05-19T08:00:00+08:00",
                        "message": "Gold remains under yields pressure.",
                        "notification_level": "level_3"
                    }).to_string()
                ],
            )
            .expect("insert alert");
        connection
            .execute(
                "INSERT INTO alerts (monitor_run_id, should_notify, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    0,
                    json!({
                        "time": "2026-05-19T08:05:00+08:00",
                        "message": "Suppressed duplicate.",
                        "notification_level": "level_1"
                    }).to_string()
                ],
            )
            .expect("insert suppressed alert");
        connection
            .execute(
                "INSERT INTO state_transitions (monitor_run_id, payload_json) VALUES (?1, ?2)",
                params![
                    1,
                    json!({
                        "state_change_reason": "main_driver usd -> yields"
                    })
                    .to_string()
                ],
            )
            .expect("insert transition");
        connection
            .execute(
                "INSERT INTO timeline_events (monitor_run_id, event_time, event_type, label, payload_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    1,
                    "2026-05-19T08:00:00+08:00",
                    "recovery_summary",
                    "Recovered move",
                    json!({
                        "monitor_run_id": 1,
                        "data_mode": "backfilled"
                    }).to_string()
                ],
            )
            .expect("insert timeline row");
        connection
            .execute(
                "INSERT INTO timeline_events (monitor_run_id, event_time, event_type, label, payload_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    1,
                    "2026-05-19T08:05:00+08:00",
                    "market_alert",
                    "Yields pressure",
                    json!({
                        "semantic_type": "breakout",
                        "impact_percent": -0.48,
                        "main_driver": "yields",
                        "summary_title": "Yields Pressure",
                        "summary": "US yields confirmed the XAUUSD down move."
                    }).to_string()
                ],
            )
            .expect("insert market turn row");
    }

    #[test]
    fn reads_market_agent_state_and_latest_alerts() {
        let dir = unique_temp_dir("snapshot");
        fs::write(
            dir.join("market_agent_state.json"),
            serde_json::to_string_pretty(&json!({
                "current_bias": "bearish_gold",
                "main_driver": "yields",
                "secondary_driver": "usd",
                "risk_driver": null,
                "confidence": "high",
                "cause_status": "confirmed",
                "last_alert_time": "2026-05-19T08:00:00+08:00",
                "last_alert_summary": "Gold remains under pressure.",
                "last_analysis_time": "2026-05-19T08:05:00+08:00",
                "last_notification_level": "level_3",
                "state_change_reason": "main_driver usd -> yields",
                "invalidation_triggered": false,
                "invalidation_triggered_by": [],
                "invalidation_conditions": ["US10Y drops more than 7 bps"]
            }))
            .expect("serialize state"),
        )
        .expect("write state");
        fs::write(
            dir.join("market_agent_alerts.ndjson"),
            [
                json!({
                    "time": "2026-05-19T08:00:00+08:00",
                    "notification_level": "level_3",
                    "message": "Gold remains under pressure.",
                    "main_driver": "yields",
                    "bias": "bearish_gold"
                })
                .to_string(),
                json!({
                    "time": "2026-05-19T07:00:00+08:00",
                    "notification_level": "level_1",
                    "message": "Earlier ping",
                    "main_driver": "unknown",
                    "bias": "unknown"
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .expect("write alerts");

        let payload = read_market_agent_snapshot(&dir, 1);

        assert_eq!(payload.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            payload.get("available").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            payload
                .get("state")
                .and_then(|v| v.get("main_driver"))
                .and_then(|v| v.as_str()),
            Some("yields")
        );
        let alerts = payload
            .get("alerts")
            .and_then(|v| v.as_array())
            .expect("alerts array");
        assert_eq!(alerts.len(), 1);
        assert_eq!(
            alerts[0].get("message").and_then(|v| v.as_str()),
            Some("Gold remains under pressure.")
        );
    }

    #[test]
    fn get_market_agent_replay_returns_replay_structure() {
        let dir = unique_temp_dir("replay");
        seed_timeline_db(&timeline_path_for_root(&dir));

        let payload = read_market_agent_replay(
            &dir,
            "2026-05-19T07:00:00+08:00",
            "2026-05-19T09:00:00+08:00",
        );

        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload.get("available").and_then(Value::as_bool),
            Some(true)
        );
        let replay = payload.get("replay").expect("replay");
        assert_eq!(
            replay
                .get("price_series")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(
            replay.get("alerts").and_then(Value::as_array).map(Vec::len),
            Some(1)
        );
        assert_eq!(
            replay
                .get("suppressed_alerts")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(
            replay
                .get("month_summary_events")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn market_replay_dedupes_repeated_news_fetches() {
        let dir = unique_temp_dir("replay-news-dedupe");
        let timeline_path = timeline_path_for_root(&dir);
        seed_timeline_db(&timeline_path);
        let connection = Connection::open(&timeline_path).expect("open sqlite");
        connection
            .execute("DELETE FROM news_items", [])
            .expect("clear seeded news rows");
        connection
            .execute(
                "INSERT INTO news_items (monitor_run_id, published_at, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    "2026-05-19T07:55:00+08:00",
                    json!({
                        "title": "Fed headline",
                        "source": "Reuters",
                        "published_at": "2026-05-19T07:55:00+08:00",
                        "first_seen_at": "2026-05-19T08:05:00+08:00",
                        "included": false,
                        "review_status": "filtered"
                    }).to_string()
                ],
            )
            .expect("insert repeated news row");
        connection
            .execute(
                "INSERT INTO news_items (monitor_run_id, published_at, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    "2026-05-19T07:55:00+08:00",
                    json!({
                        "title": "Fed headline",
                        "source": "Reuters",
                        "published_at": "2026-05-19T07:55:00+08:00",
                        "first_seen_at": "2026-05-19T08:19:00+08:00",
                        "included": false,
                        "review_status": "filtered",
                        "summary_source": "Local AI",
                        "summary": "Repeated headline should render once in replay."
                    }).to_string()
                ],
            )
            .expect("insert preferred repeated news row");

        let payload = read_market_agent_replay(
            &dir,
            "2026-05-19T07:00:00+08:00",
            "2026-05-19T09:00:00+08:00",
        );
        let news_items = payload
            .get("replay")
            .and_then(|replay| replay.get("news_items"))
            .and_then(Value::as_array)
            .expect("news items");

        assert_eq!(news_items.len(), 1);
        assert_eq!(
            news_items[0].get("summary_source").and_then(Value::as_str),
            Some("Local AI")
        );
        assert_eq!(
            news_items[0].get("seen_count").and_then(Value::as_i64),
            Some(2)
        );
        assert_eq!(
            news_items[0].get("duplicate_count").and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            news_items[0].get("last_seen_at").and_then(Value::as_str),
            Some("2026-05-19T08:19:00+08:00")
        );
    }

    #[test]
    fn market_replay_uses_existing_calendar_when_timeline_has_no_calendar_rows() {
        let dir = unique_temp_dir("replay-calendar-fallback");
        seed_timeline_db(&timeline_path_for_root(&dir));
        let connection = Connection::open(timeline_path_for_root(&dir)).expect("open sqlite");
        connection
            .execute("DELETE FROM calendar_events", [])
            .expect("clear calendar rows");
        let year_dir = dir.join("data").join("Economic_Calendar").join("2026");
        fs::create_dir_all(&year_dir).expect("create calendar dir");
        fs::write(
            year_dir.join("2026_calendar.json"),
            json!([
                {
                    "Date": "2026-05-19",
                    "Day": "Tuesday",
                    "Time": "08:15",
                    "Cur.": "USD",
                    "Imp.": "High",
                    "Event": "Core CPI (MoM)",
                    "Actual": "",
                    "Forecast": "0.3%",
                    "Previous": "0.2%"
                },
                {
                    "Date": "2026-05-19",
                    "Day": "Tuesday",
                    "Time": "08:20",
                    "Cur.": "NZD",
                    "Imp.": "Low",
                    "Event": "Low noise event",
                    "Actual": "",
                    "Forecast": "",
                    "Previous": ""
                }
            ])
            .to_string(),
        )
        .expect("write calendar json");

        let payload = read_market_agent_replay(
            &dir,
            "2026-05-19T07:00:00+08:00",
            "2026-05-19T09:00:00+08:00",
        );

        let events = payload
            .get("replay")
            .and_then(|replay| replay.get("calendar_events"))
            .and_then(Value::as_array)
            .expect("calendar events");
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0].get("title").and_then(Value::as_str),
            Some("Core CPI (MoM)")
        );
        assert_eq!(
            events[0].get("data_mode").and_then(Value::as_str),
            Some("calendar_context")
        );
        assert_eq!(
            events[0].get("review_status").and_then(Value::as_str),
            Some("unreviewed_context")
        );
        assert_eq!(
            events[0].get("storage_status").and_then(Value::as_str),
            Some("read_from_existing_calendar")
        );
    }

    #[test]
    fn market_replay_prefers_existing_calendar_over_stored_calendar_trace() {
        let dir = unique_temp_dir("replay-calendar-source-of-truth");
        seed_timeline_db(&timeline_path_for_root(&dir));
        let year_dir = dir.join("data").join("Economic_Calendar").join("2026");
        fs::create_dir_all(&year_dir).expect("create calendar dir");
        fs::write(
            year_dir.join("2026_calendar.json"),
            json!([
                {
                    "Date": "2026-05-19",
                    "Day": "Tuesday",
                    "Time": "08:15",
                    "Cur.": "USD",
                    "Imp.": "High",
                    "Event": "Real Calendar CPI",
                    "Actual": "",
                    "Forecast": "0.3%",
                    "Previous": "0.2%"
                }
            ])
            .to_string(),
        )
        .expect("write calendar json");

        let payload = read_market_agent_replay(
            &dir,
            "2026-05-19T07:00:00+08:00",
            "2026-05-19T09:00:00+08:00",
        );

        let events = payload
            .get("replay")
            .and_then(|replay| replay.get("calendar_events"))
            .and_then(Value::as_array)
            .expect("calendar events");
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].get("title").and_then(Value::as_str),
            Some("Real Calendar CPI")
        );
        assert_eq!(
            events[0].get("source").and_then(Value::as_str),
            Some("Economic Calendar")
        );
    }

    #[test]
    fn missing_sqlite_returns_available_false_not_panic() {
        let dir = unique_temp_dir("missing");
        let payload = read_market_agent_replay(
            &dir,
            "2026-05-19T07:00:00+08:00",
            "2026-05-19T09:00:00+08:00",
        );

        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload.get("available").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            payload
                .get("replay")
                .and_then(|replay| replay.get("price_series"))
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        assert_eq!(
            payload
                .get("replay")
                .and_then(|replay| replay.get("related_assets"))
                .and_then(Value::as_object)
                .map(|items| items.len()),
            Some(0)
        );
    }

    #[test]
    fn malformed_timeline_rows_are_ignored_without_panicking() {
        let dir = unique_temp_dir("malformed");
        seed_timeline_db(&timeline_path_for_root(&dir));
        let connection = Connection::open(timeline_path_for_root(&dir)).expect("open sqlite");
        connection
            .execute(
                "INSERT INTO news_items (monitor_run_id, published_at, payload_json) VALUES (?1, ?2, ?3)",
                params![1, "2026-05-19T08:01:00+08:00", "{bad json"],
            )
            .expect("insert malformed row");

        let payload = read_market_agent_replay(
            &dir,
            "2026-05-19T07:00:00+08:00",
            "2026-05-19T09:00:00+08:00",
        );

        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload.get("available").and_then(Value::as_bool),
            Some(true)
        );
        let replay = payload.get("replay").expect("replay");
        assert_eq!(
            replay
                .get("news_items")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn saves_and_reads_masked_ctrader_provider_config() {
        let dir = unique_temp_dir("ctrader-config");
        let payload = json!({
            "ctrader": {
                "enabled": true,
                "environment": "demo",
                "accountId": "123456",
                "ctid": "trader@example.com",
                "password": "super-secret-password",
                "symbol": "XAUUSD",
                "symbolId": 777,
                "snapshotPath": dir.join("ctrader-last-quote.json").display().to_string(),
                "quoteTimeoutSeconds": 9,
                "quoteStaleAfterSeconds": 15,
                "allowSavedSnapshotFallback": true
            }
        });

        let saved = save_ctrader_provider_config(&dir, &payload).expect("save config");
        let read_back = masked_ctrader_provider_config(&dir);

        assert_eq!(saved.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            read_back
                .get("ctrader")
                .and_then(|value| value.get("enabled"))
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_ne!(
            read_back
                .get("ctrader")
                .and_then(|value| value.get("passwordMasked"))
                .and_then(Value::as_str),
            Some("super-secret-password")
        );
        assert!(!read_back.to_string().contains("super-secret-password"));
        assert!(read_back.to_string().contains("ctidMasked"));
        assert!(read_back.to_string().contains("hasPassword"));
        assert!(ctrader_config_path_for_root(&dir).exists());
    }

    #[test]
    fn masks_non_ascii_secrets_without_byte_boundary_panic() {
        let masked = mask_secret("密碼🔐abc");

        assert_ne!(masked, "密碼🔐abc");
        assert!(!masked.contains("密碼🔐abc"));
        assert!(masked.starts_with("密碼"));
        assert!(masked.ends_with("bc"));
    }

    #[test]
    fn saves_ctrader_config_without_clearing_existing_empty_secrets() {
        let dir = unique_temp_dir("ctrader-secret-merge");
        save_ctrader_provider_config(
            &dir,
            &json!({
                "ctrader": {
                    "enabled": true,
                    "environment": "demo",
                    "accountId": "123456",
                    "ctid": "trader@example.com",
                    "password": "super-secret-password",
                    "symbol": "XAUUSD",
                    "snapshotPath": dir.join("ctrader-last-quote.json").display().to_string(),
                }
            }),
        )
        .expect("seed config");

        save_ctrader_provider_config(
            &dir,
            &json!({
                "ctrader": {
                    "enabled": false,
                    "accountId": "654321",
                    "ctid": "",
                    "password": "   "
                }
            }),
        )
        .expect("save config with empty secrets");

        let raw = read_json_object(&ctrader_config_path_for_root(&dir));

        assert_eq!(raw.get("enabled").and_then(Value::as_bool), Some(false));
        assert_eq!(raw.get("accountId").and_then(Value::as_str), Some("654321"));
        assert_eq!(
            raw.get("ctid").and_then(Value::as_str),
            Some("trader@example.com")
        );
        assert_eq!(
            raw.get("password").and_then(Value::as_str),
            Some("super-secret-password")
        );
    }

    #[test]
    fn clears_ctrader_provider_config_without_panicking() {
        let dir = unique_temp_dir("ctrader-clear");
        fs::write(
            ctrader_config_path_for_root(&dir),
            json!({"enabled": true}).to_string(),
        )
        .expect("write config");
        fs::write(
            dir.join(format!("{}.json", ["ctrader", "token"].join("-"))),
            json!({"legacySecret": "secret"}).to_string(),
        )
        .expect("write legacy store");

        let response = clear_ctrader_provider_config(&dir).expect("clear config");

        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
        assert!(!ctrader_config_path_for_root(&dir).exists());
        assert!(!dir
            .join(format!("{}.json", ["ctrader", "token"].join("-")))
            .exists());
    }

    #[test]
    fn ctrader_env_for_monitor_points_to_cli_config_without_secrets() {
        let dir = unique_temp_dir("ctrader-env");
        save_ctrader_provider_config(
            &dir,
            &json!({
                "ctrader": {
                    "enabled": true,
                    "environment": "demo",
                    "accountId": "123456",
                    "ctid": "trader@example.com",
                    "password": "super-secret-password",
                    "symbol": "XAUUSD",
                    "snapshotPath": dir.join("ctrader-last-quote.json").display().to_string(),
                }
            }),
        )
        .expect("seed config");

        let env = ctrader_env_for_root(&dir);
        assert_eq!(
            env.get("CTRADER_CONFIG_PATH").map(String::as_str),
            Some(dir.join("ctrader-cli.json").display().to_string().as_str())
        );
        assert!(!format!("{env:?}").contains("super-secret-password"));
    }

    #[test]
    fn ctrader_env_for_monitor_uses_live_snapshot_file() {
        let dir = unique_temp_dir("ctrader-env-live-snapshot");

        let env = ctrader_env_for_root(&dir);
        let expected = live_quote_snapshot_path_for_root(&dir)
            .to_string_lossy()
            .to_string();

        assert_eq!(
            env.get("CTRADER_SNAPSHOT_PATH").map(String::as_str),
            Some(expected.as_str())
        );
        assert_eq!(
            env.get("MARKET_AGENT_CTRADER_SAVED_SNAPSHOT_PATH")
                .map(String::as_str),
            Some(expected.as_str())
        );
        assert_eq!(
            env.get("CTRADER_QUOTE_BRIDGE_ENABLED").map(String::as_str),
            Some("false")
        );
    }

    #[test]
    fn reads_saved_ctrader_health_without_live_bridge_refresh() {
        let dir = unique_temp_dir("ctrader-snapshot-health");
        let snapshot_path = dir.join("ctrader-last-quote.json");
        save_ctrader_provider_config(
            &dir,
            &json!({
                "ctrader": {
                    "enabled": true,
                    "environment": "demo",
                    "accountId": "123456",
                    "ctid": "trader@example.com",
                    "password": "super-secret-password",
                    "symbol": "XAUUSD",
                    "snapshotPath": snapshot_path.display().to_string(),
                }
            }),
        )
        .expect("seed config");
        fs::write(
            &snapshot_path,
            json!({
                "symbol": "XAUUSD",
                "symbol_id": 777,
                "bid": 4507.9,
                "ask": 4508.3,
                "mid": 4508.1,
                "timestamp": "2026-05-22T20:56:59Z",
                "source_type": "spot"
            })
            .to_string(),
        )
        .expect("write snapshot");

        let health = read_saved_ctrader_xauusd_health(&dir).expect("health");

        assert_eq!(
            health.get("source").and_then(Value::as_str),
            Some("cTrader")
        );
        assert_eq!(
            health.get("current_value").and_then(Value::as_f64),
            Some(4508.1)
        );
        assert_eq!(
            health.get("data_mode").and_then(Value::as_str),
            Some("snapshot")
        );
        assert_eq!(
            health.get("source_type").and_then(Value::as_str),
            Some("spot_snapshot")
        );
        assert_eq!(
            health.get("is_available").and_then(Value::as_bool),
            Some(true)
        );
        assert!(health
            .get("stale_reason")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("saved cTrader quote snapshot"));
    }

    #[test]
    fn live_quote_response_reads_snapshot_without_process_probe() {
        let dir = unique_temp_dir("live-quote-no-probe");
        let status_path = live_quote_stream_status_path_for_root(&dir);
        let snapshot_path = live_quote_snapshot_path_for_root(&dir);
        write_json_atomic(
            &status_path,
            &json!({
                "ok": true,
                "running": true,
                "phase": "running",
                "pid": 99999999,
                "message": "cTrader live quote stream is running.",
                "snapshotPath": snapshot_path.display().to_string(),
            }),
        )
        .expect("write live status");
        write_json_atomic(
            &snapshot_path,
            &json!({
                "ok": true,
                "symbol": "XAUUSD",
                "bid": 4569.3,
                "ask": 4569.37,
                "mid": 4569.335,
                "timestamp": Utc::now().to_rfc3339(),
            }),
        )
        .expect("write live snapshot");

        let response = build_live_quote_response(&dir);
        let saved_status = read_json_file(&status_path).expect("read saved status");

        assert_eq!(response.get("running").and_then(Value::as_bool), Some(true));
        assert_eq!(
            response
                .get("quote")
                .and_then(|quote| quote.get("mid"))
                .and_then(Value::as_f64),
            Some(4569.335)
        );
        assert_eq!(
            saved_status.get("pid").and_then(Value::as_i64),
            Some(99999999)
        );
    }

    #[test]
    fn live_quote_status_probe_clears_dead_pid_only_when_requested() {
        let dir = unique_temp_dir("live-quote-probe");
        let status_path = live_quote_stream_status_path_for_root(&dir);
        write_json_atomic(
            &status_path,
            &json!({
                "ok": true,
                "running": true,
                "phase": "running",
                "pid": 99999999,
                "message": "cTrader live quote stream is running.",
            }),
        )
        .expect("write live status");

        let unchecked = read_live_quote_stream_status_for_root(&dir, false);
        let checked = read_live_quote_stream_status_for_root(&dir, true);

        assert_eq!(
            unchecked.get("running").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(checked.get("running").and_then(Value::as_bool), Some(false));
        assert_eq!(
            checked.get("phase").and_then(Value::as_str),
            Some("starting")
        );
        assert_eq!(checked.get("lastError").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn live_quote_status_normalizes_old_stopped_error() {
        let dir = unique_temp_dir("live-quote-old-stopped");
        let status_path = live_quote_stream_status_path_for_root(&dir);
        let snapshot_path = live_quote_snapshot_path_for_root(&dir);
        write_json_atomic(
            &status_path,
            &json!({
                "ok": false,
                "running": false,
                "phase": "stopped",
                "pid": null,
                "message": "Live quote stream stopped unexpectedly.",
                "lastError": "Saved live stream status referenced a process that is no longer running.",
                "snapshotPath": snapshot_path.display().to_string(),
            }),
        )
        .expect("write old live status");

        let status = read_live_quote_stream_status_for_root(&dir, true);
        let saved = read_json_file(&status_path).expect("saved status");

        assert_eq!(status.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(status.get("running").and_then(Value::as_bool), Some(false));
        assert_eq!(
            status.get("phase").and_then(Value::as_str),
            Some("starting")
        );
        assert_eq!(status.get("lastError").and_then(Value::as_str), Some(""));
        assert_eq!(saved.get("phase").and_then(Value::as_str), Some("starting"));
    }

    #[test]
    fn live_quote_status_normalizes_old_launcher_error() {
        let dir = unique_temp_dir("live-quote-old-launcher");
        let status_path = live_quote_stream_status_path_for_root(&dir);
        write_json_atomic(
            &status_path,
            &json!({
                "ok": false,
                "running": false,
                "phase": "stopped",
                "pid": null,
                "bridgePid": 23216,
                "message": "Live quote stream stopped unexpectedly.",
                "lastError": "Saved live stream launcher process ended and no fresh cTrader snapshot is available.",
            }),
        )
        .expect("write old launcher status");

        let status = read_live_quote_stream_status_for_root(&dir, true);

        assert_eq!(status.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(status.get("running").and_then(Value::as_bool), Some(false));
        assert_eq!(
            status.get("phase").and_then(Value::as_str),
            Some("starting")
        );
        assert_eq!(status.get("bridgePid"), Some(&Value::Null));
        assert_eq!(status.get("lastError").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn live_quote_status_probe_keeps_dead_launcher_when_snapshot_is_fresh() {
        let dir = unique_temp_dir("live-quote-fresh-snapshot");
        let status_path = live_quote_stream_status_path_for_root(&dir);
        let snapshot_path = live_quote_snapshot_path_for_root(&dir);
        write_json_atomic(
            &status_path,
            &json!({
                "ok": true,
                "running": true,
                "phase": "running",
                "pid": 99999999,
                "message": "cTrader live quote stream is running.",
                "lastError": "old error",
            }),
        )
        .expect("write live status");
        write_json_atomic(
            &snapshot_path,
            &json!({
                "ok": true,
                "symbol": "XAUUSD",
                "bid": 4570.74,
                "ask": 4570.85,
                "mid": 4570.795,
                "timestamp": chrono::Utc::now().to_rfc3339(),
            }),
        )
        .expect("write live snapshot");

        let checked = read_live_quote_stream_status_for_root(&dir, true);

        assert_eq!(checked.get("running").and_then(Value::as_bool), Some(true));
        assert_eq!(
            checked.get("phase").and_then(Value::as_str),
            Some("running")
        );
        assert_eq!(
            checked.get("message").and_then(Value::as_str),
            Some("cTrader live quote stream is producing fresh snapshots.")
        );
        assert_eq!(checked.get("lastError").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn runtime_live_quote_overrides_stale_xauusd_provider_health() {
        let dir = unique_temp_dir("provider-health-runtime-override");
        let timeline_path = timeline_path_for_root(&dir);
        seed_timeline_db(&timeline_path);
        write_json_atomic(
            &live_quote_stream_status_path_for_root(&dir),
            &json!({
                "ok": true,
                "running": true,
                "phase": "running",
                "pid": 123456,
                "message": "cTrader live quote stream is producing fresh snapshots.",
                "snapshotPath": live_quote_snapshot_path_for_root(&dir).display().to_string(),
            }),
        )
        .expect("write live status");
        write_json_atomic(
            &live_quote_snapshot_path_for_root(&dir),
            &json!({
                "ok": true,
                "symbol": "XAUUSD",
                "bid": 4538.08,
                "ask": 4538.15,
                "mid": 4538.115,
                "timestamp": chrono::Utc::now().to_rfc3339(),
            }),
        )
        .expect("write live snapshot");

        let connection = Connection::open(&timeline_path).expect("open sqlite");
        let (_, _, items) = read_provider_health_latest(&connection).expect("read provider health");
        let merged = merge_xauusd_provider_health(
            items,
            read_runtime_ctrader_xauusd_health(&dir).expect("runtime health"),
        );
        let xauusd = merged
            .iter()
            .find(|item| item.get("provider_key").and_then(Value::as_str) == Some("xauusd"))
            .expect("xauusd health");

        assert_eq!(
            xauusd.get("source").and_then(Value::as_str),
            Some("cTrader")
        );
        assert_eq!(
            xauusd.get("source_type").and_then(Value::as_str),
            Some("spot")
        );
        assert_eq!(
            xauusd.get("data_mode").and_then(Value::as_str),
            Some("live_seen")
        );
        assert_eq!(
            xauusd.get("is_available").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(xauusd.get("is_stale").and_then(Value::as_bool), Some(false));
        assert_eq!(
            xauusd.get("current_value").and_then(Value::as_f64),
            Some(4538.115)
        );
    }

    #[test]
    fn provider_health_latest_uses_run_started_at_not_insert_order() {
        let dir = unique_temp_dir("provider-health-latest-run-time");
        let timeline_path = timeline_path_for_root(&dir);
        seed_timeline_db(&timeline_path);
        let connection = Connection::open(&timeline_path).expect("open sqlite");
        connection
            .execute(
                "INSERT INTO monitor_runs (run_started_at, run_type, data_mode, backfill_required, no_news_found, alert_suppressed_reason, created_at)
                 VALUES ('2026-05-19T07:15:00+08:00', 'live', 'live_seen', 0, 0, 'inserted later by replay', '2026-05-19T07:15:00+08:00')",
                [],
            )
            .expect("insert older run");
        let older_run_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO provider_health (monitor_run_id, provider_key, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    older_run_id,
                    "xauusd",
                    json!({
                        "source": "cTrader",
                        "source_type": "spot",
                        "data_mode": "live_seen",
                        "is_available": true,
                        "is_stale": false,
                        "data_timestamp": "2026-05-19T07:15:00+08:00",
                    })
                    .to_string()
                ],
            )
            .expect("insert older health");

        let (monitor_run_id, run_started_at, items) =
            read_provider_health_latest(&connection).expect("read provider health");

        assert_eq!(monitor_run_id, Some(1));
        assert_eq!(run_started_at.as_deref(), Some("2026-05-19T08:00:00+08:00"));
        assert_eq!(
            items[0].get("source").and_then(Value::as_str),
            Some("Yahoo Finance")
        );
    }

    #[test]
    fn live_quote_response_marks_dead_stale_stream_as_not_running() {
        let dir = unique_temp_dir("live-quote-dead-stale-response");
        let status_path = live_quote_stream_status_path_for_root(&dir);
        let snapshot_path = live_quote_snapshot_path_for_root(&dir);
        write_json_atomic(
            &status_path,
            &json!({
                "ok": true,
                "running": true,
                "phase": "running",
                "pid": 99999999,
                "message": "cTrader live quote stream is running.",
                "snapshotPath": snapshot_path.display().to_string(),
            }),
        )
        .expect("write live status");
        write_json_atomic(
            &snapshot_path,
            &json!({
                "ok": true,
                "symbol": "XAUUSD",
                "bid": 4570.74,
                "ask": 4570.85,
                "mid": 4570.795,
                "timestamp": "2026-05-25T16:43:12.3250000Z",
            }),
        )
        .expect("write live snapshot");
        let stale_time = FileTime::from_system_time(SystemTime::now() - Duration::from_secs(120));
        set_file_mtime(&snapshot_path, stale_time).expect("age snapshot");

        let response = build_live_quote_response(&dir);
        let saved_status = read_json_file(&status_path).expect("read saved status");

        assert_eq!(
            response.get("running").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(response.get("phase").and_then(Value::as_str), Some("stale"));
        assert_eq!(
            response
                .get("provider_health")
                .and_then(|health| health.get("is_stale"))
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            saved_status.get("running").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(saved_status.get("pid"), Some(&Value::Null));
    }

    #[test]
    fn live_quote_response_marks_weekend_stale_snapshot_as_market_closed() {
        let dir = unique_temp_dir("live-quote-weekend-closed");
        let status_path = live_quote_stream_status_path_for_root(&dir);
        let snapshot_path = live_quote_snapshot_path_for_root(&dir);
        write_json_atomic(
            &status_path,
            &json!({
                "ok": true,
                "running": true,
                "phase": "running",
                "pid": 99999999,
                "message": "cTrader live quote stream is running.",
                "snapshotPath": snapshot_path.display().to_string(),
            }),
        )
        .expect("write live status");
        write_json_atomic(
            &snapshot_path,
            &json!({
                "ok": true,
                "symbol": "XAUUSD",
                "bid": 4541.13,
                "ask": 4541.53,
                "mid": 4541.33,
                "timestamp": "2026-05-29T20:56:59.947000+00:00",
            }),
        )
        .expect("write live snapshot");
        let stale_time = FileTime::from_system_time(SystemTime::now() - Duration::from_secs(120));
        set_file_mtime(&snapshot_path, stale_time).expect("age snapshot");

        let response = build_live_quote_response_at(
            &dir,
            chrono::DateTime::parse_from_rfc3339("2026-05-31T16:28:00+08:00")
                .expect("parse now")
                .with_timezone(&chrono::Utc),
        );

        assert_eq!(
            response.get("running").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            response.get("phase").and_then(Value::as_str),
            Some("market_closed")
        );
        assert_eq!(
            response
                .get("provider_health")
                .and_then(|health| health.get("data_mode"))
                .and_then(Value::as_str),
            Some("stale")
        );
        assert_eq!(
            response
                .get("provider_health")
                .and_then(|health| health.get("metadata"))
                .and_then(|metadata| metadata.get("stale_classification"))
                .and_then(Value::as_str),
            Some("market_closed")
        );
    }

    #[test]
    fn live_quote_response_ignores_stale_status_error_when_market_closed_snapshot_exists() {
        let dir = unique_temp_dir("live-quote-market-closed-status-error");
        let status_path = live_quote_stream_status_path_for_root(&dir);
        let snapshot_path = live_quote_snapshot_path_for_root(&dir);
        write_json_atomic(
            &status_path,
            &json!({
                "ok": false,
                "running": false,
                "phase": "error",
                "pid": null,
                "message": "Unable to update cTrader live quote stream status.",
                "lastError": "[WinError 5] Access is denied while replacing ctrader-live-quote.json",
                "snapshotPath": snapshot_path.display().to_string(),
            }),
        )
        .expect("write status");
        write_json_atomic(
            &snapshot_path,
            &json!({
                "ok": true,
                "symbol": "XAUUSD",
                "bid": 4541.13,
                "ask": 4541.53,
                "mid": 4541.33,
                "timestamp": "2026-05-29T20:56:59.947000+00:00",
            }),
        )
        .expect("write live snapshot");
        let stale_time = FileTime::from_system_time(SystemTime::now() - Duration::from_secs(120));
        set_file_mtime(&snapshot_path, stale_time).expect("age snapshot");

        let response = build_live_quote_response_at(
            &dir,
            chrono::DateTime::parse_from_rfc3339("2026-05-31T16:28:00+08:00")
                .expect("parse now")
                .with_timezone(&chrono::Utc),
        );

        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            response.get("phase").and_then(Value::as_str),
            Some("market_closed")
        );
        assert_eq!(response.get("lastError").and_then(Value::as_str), Some(""));
        assert_eq!(
            response
                .get("provider_health")
                .and_then(|health| health.get("metadata"))
                .and_then(|metadata| metadata.get("stale_classification"))
                .and_then(Value::as_str),
            Some("market_closed")
        );
    }

    #[test]
    fn live_quote_start_does_not_spawn_cli_cbot_stream() {
        let dir = unique_temp_dir("live-quote-credentials-required");
        write_json_atomic(
            &ctrader_config_path_for_root(&dir),
            &json!({
                "enabled": true,
                "accountId": "",
                "ctid": "",
                "password": "",
                "symbol": "XAUUSD"
            }),
        )
        .expect("seed empty ctrader config");

        let response = start_live_quote_stream_for_root(&dir);
        let saved =
            read_json_file(&live_quote_stream_status_path_for_root(&dir)).expect("read status");

        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            response.get("running").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            response.get("phase").and_then(Value::as_str),
            Some("credentials_required")
        );
        assert_eq!(
            response.get("message").and_then(Value::as_str),
            Some("cTrader live stream requires saved account credentials.")
        );
        assert_eq!(saved.get("pid"), Some(&Value::Null));
    }

    #[test]
    fn start_ctrader_connect_saves_config_without_running_cli_bridge() {
        let dir = unique_temp_dir("ctrader-connect-no-bridge");
        let payload = json!({
            "ctrader": {
                "enabled": true,
                "environment": "demo",
                "accountId": "123456",
                "ctid": "trader@example.com",
                "password": "super-secret-password",
                "symbol": "XAUUSD",
                "symbolId": 777,
                "snapshotPath": dir.join("old-quote.json").display().to_string(),
                "quoteTimeoutSeconds": 9,
                "quoteStaleAfterSeconds": 15,
                "allowSavedSnapshotFallback": true
            }
        });

        let response = start_ctrader_connect_for_root(&dir, payload);
        let raw_config = read_json_object(&ctrader_config_path_for_root(&dir));
        let stream_status =
            read_json_file(&live_quote_stream_status_path_for_root(&dir)).expect("stream status");
        let spawn_debug =
            fs::read_to_string(dir.join("market_agent_spawn_debug.ndjson")).unwrap_or_default();

        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            response.get("status").and_then(Value::as_str),
            Some("starting_live_stream")
        );
        assert_eq!(
            raw_config.get("snapshotPath").and_then(Value::as_str),
            Some(
                live_quote_snapshot_path_for_root(&dir)
                    .display()
                    .to_string()
                    .as_str()
            )
        );
        assert_eq!(
            stream_status.get("phase").and_then(Value::as_str),
            Some("starting")
        );
        assert!(!spawn_debug.contains("tauri_ctrader_bridge"));
        assert!(!spawn_debug.contains("test-connection"));
        assert!(!response.to_string().contains("super-secret-password"));
    }

    #[test]
    fn run_ctrader_bridge_rejects_shell_adapter_without_spawning_python() {
        let dir = unique_temp_dir("ctrader-bridge-shell-block");
        let adapter_path = dir.join("ctrader-cli-adapter.cmd");
        fs::write(&adapter_path, "@echo off\r\n").expect("write adapter");
        save_ctrader_provider_config(
            &dir,
            &json!({
                "ctrader": {
                    "enabled": true,
                    "environment": "demo",
                    "accountId": "123456",
                    "ctid": "trader@example.com",
                    "password": "super-secret-password",
                    "symbol": "XAUUSD",
                    "snapshotPath": dir.join("ctrader-last-quote.json").display().to_string(),
                    "cliExecutable": adapter_path.display().to_string(),
                }
            }),
        )
        .expect("seed config");

        for command in ["test-connection", "quote", "backfill"] {
            let response = run_ctrader_bridge(&dir, command, &json!({}));

            assert_eq!(response.get("ok").and_then(Value::as_bool), Some(false));
            assert_eq!(
                response.get("status").and_then(Value::as_str),
                Some("disabled")
            );
            assert!(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("")
                .contains("disabled"));
        }
        let spawn_debug =
            fs::read_to_string(dir.join("market_agent_spawn_debug.ndjson")).unwrap_or_default();
        assert!(!spawn_debug.contains("\"event\":\"spawn_request\""));
        assert!(!spawn_debug.contains("python"));
        assert!(!spawn_debug.contains("super-secret-password"));
    }

    #[test]
    fn saves_and_reads_masked_telegram_config() {
        let dir = unique_temp_dir("telegram-config");
        let payload = json!({
            "telegram": {
                "enabled": true,
                "botToken": "1234567890:secret-token",
                "chatId": "987654321",
                "timeoutSeconds": 12,
                "levels": ["level_2", "level_3"]
            }
        });

        let saved = save_telegram_config_for_root(&dir, &payload).expect("save telegram config");
        let read_back = masked_telegram_config_for_root(&dir);

        assert_eq!(saved.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            read_back
                .get("telegram")
                .and_then(|value| value.get("enabled"))
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            read_back
                .get("telegram")
                .and_then(|value| value.get("botTokenMasked"))
                .and_then(Value::as_str),
            Some("12*******************en")
        );
        assert!(!read_back.to_string().contains("secret-token"));
    }

    #[test]
    fn saves_telegram_config_without_clearing_existing_empty_token() {
        let dir = unique_temp_dir("telegram-secret-merge");
        save_telegram_config_for_root(
            &dir,
            &json!({
                "telegram": {
                    "enabled": true,
                    "botToken": "1234567890:secret-token",
                    "chatId": "987654321",
                    "timeoutSeconds": 12,
                    "levels": ["level_2", "level_3"]
                }
            }),
        )
        .expect("seed telegram config");

        save_telegram_config_for_root(
            &dir,
            &json!({
                "telegram": {
                    "enabled": false,
                    "botToken": " ",
                    "chatId": "123",
                    "timeoutSeconds": 8,
                    "levels": ["level_3"]
                }
            }),
        )
        .expect("save telegram config with empty token");

        let raw = read_json_object(&telegram_config_path_for_root(&dir));

        assert_eq!(raw.get("enabled").and_then(Value::as_bool), Some(false));
        assert_eq!(
            raw.get("botToken").and_then(Value::as_str),
            Some("1234567890:secret-token")
        );
        assert_eq!(raw.get("chatId").and_then(Value::as_str), Some("123"));
        assert_eq!(raw.get("timeoutSeconds").and_then(Value::as_i64), Some(8));
    }

    #[test]
    fn telegram_env_for_monitor_uses_saved_config_without_exposing_passwords() {
        let dir = unique_temp_dir("telegram-env");
        save_telegram_config_for_root(
            &dir,
            &json!({
                "telegram": {
                    "enabled": true,
                    "botToken": "token",
                    "chatId": "chat",
                    "timeoutSeconds": 9,
                    "levels": ["level_3"]
                }
            }),
        )
        .expect("save telegram");

        let env = telegram_env_for_root(&dir);

        assert_eq!(
            env.get("MARKET_AGENT_TELEGRAM_ENABLED").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            env.get("MARKET_AGENT_TELEGRAM_BOT_TOKEN")
                .map(String::as_str),
            Some("token")
        );
        assert_eq!(
            env.get("MARKET_AGENT_TELEGRAM_LEVELS").map(String::as_str),
            Some("level_3")
        );
    }

    #[test]
    fn saves_and_reads_llm_config_for_monitor_env() {
        let dir = unique_temp_dir("llm-config");
        let payload = json!({
            "llm": {
                "enabled": true,
                "provider": "ollama",
                "endpoint": "http://localhost:11434",
                "model": "qwen3.5:4b",
                "temperature": DEFAULT_LLM_TEMPERATURE,
                "timeoutSeconds": DEFAULT_LLM_TIMEOUT_SECONDS,
                "keepAlive": "0",
                "maxContext": 8192
            }
        });

        let saved = save_llm_config_for_root(&dir, &payload).expect("save llm config");
        let read_back = masked_llm_config_for_root(&dir);
        let env = llm_env_for_root(&dir);

        assert_eq!(saved.get("ok").and_then(Value::as_bool), Some(true));
        assert!(llm_config_path_for_root(&dir).exists());
        assert_eq!(
            read_back
                .get("llm")
                .and_then(|value| value.get("model"))
                .and_then(Value::as_str),
            Some("qwen3.5:4b")
        );
        assert_eq!(
            read_back
                .get("llm")
                .and_then(|value| value.get("endpoint"))
                .and_then(Value::as_str),
            Some(DEFAULT_OLLAMA_ENDPOINT)
        );
        assert_eq!(
            env.get("LOCAL_LLM_ENABLED").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            env.get("LOCAL_LLM_ENDPOINT").map(String::as_str),
            Some(DEFAULT_OLLAMA_ENDPOINT)
        );
        assert_eq!(
            env.get("LOCAL_LLM_MODEL").map(String::as_str),
            Some("qwen3.5:4b")
        );
    }

    #[test]
    fn recommends_local_model_from_gpu_and_memory_profile() {
        let rtx3060ti = json!({
            "os": "windows",
            "cpu": "AMD Ryzen",
            "ramBytes": 34_359_738_368_i64,
            "gpuVendor": "NVIDIA",
            "gpuName": "NVIDIA GeForce RTX 3060 Ti",
            "vramBytes": 8_589_934_592_i64,
            "nvidiaAvailable": true
        });
        let rtx3090 = json!({
            "os": "windows",
            "cpu": "AMD Ryzen",
            "ramBytes": 68_719_476_736_i64,
            "gpuVendor": "NVIDIA",
            "gpuName": "NVIDIA GeForce RTX 3090",
            "vramBytes": 25_769_803_776_i64,
            "nvidiaAvailable": true
        });
        let cpu_only = json!({
            "os": "windows",
            "cpu": "Laptop CPU",
            "ramBytes": 8_589_934_592_i64,
            "gpuVendor": "",
            "gpuName": "",
            "vramBytes": 0,
            "nvidiaAvailable": false
        });

        assert_eq!(
            recommend_local_model_from_profile(&rtx3060ti)
                .get("name")
                .and_then(Value::as_str),
            Some("qwen3.5:4b")
        );
        assert_eq!(
            recommend_local_model_from_profile(&rtx3090)
                .get("name")
                .and_then(Value::as_str),
            Some("qwen3.5:4b")
        );
        assert_eq!(
            recommend_local_model_from_profile(&cpu_only)
                .get("name")
                .and_then(Value::as_str),
            Some("qwen3.5:0.8b")
        );
    }

    #[test]
    fn llm_fallback_policy_downgrades_before_rule_based_only() {
        let invalid_4b =
            apply_llm_fallback_policy_for_result("qwen3.5:4b", "invalid_json", Some(900));
        let slow_2b =
            apply_llm_fallback_policy_for_result("qwen3.5:2b", "model_too_slow", Some(12_500));
        let failed_light =
            apply_llm_fallback_policy_for_result("qwen3.5:0.8b", "invalid_json", Some(1500));

        assert_eq!(
            invalid_4b.get("model").and_then(Value::as_str),
            Some("qwen3.5:2b")
        );
        assert_eq!(
            slow_2b.get("model").and_then(Value::as_str),
            Some("qwen3.5:0.8b")
        );
        assert_eq!(
            failed_light.get("status").and_then(Value::as_str),
            Some("llm_disabled")
        );
        assert_eq!(
            failed_light.get("ruleBasedActive").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn ollama_pull_progress_reports_bytes_and_percent() {
        let progress = normalize_pull_progress_line(
            "qwen3.5:4b",
            r#"{"status":"pulling manifest","digest":"sha256:abc","completed":1450000000,"total":2900000000}"#,
        );

        assert_eq!(
            progress.get("model").and_then(Value::as_str),
            Some("qwen3.5:4b")
        );
        assert_eq!(
            progress.get("completedBytes").and_then(Value::as_i64),
            Some(1_450_000_000)
        );
        assert_eq!(
            progress.get("totalBytes").and_then(Value::as_i64),
            Some(2_900_000_000)
        );
        assert_eq!(progress.get("percent").and_then(Value::as_f64), Some(50.0));
    }

    #[test]
    fn ctrader_cli_config_is_saved_with_masked_response_only() {
        let dir = unique_temp_dir("ctrader-cli-save");
        let response = save_ctrader_provider_config(
            &dir,
            &json!({
                "ctrader": {
                    "enabled": true,
                    "accountId": "123456",
                    "ctid": "trader@example.com",
                    "password": "super-secret-password",
                    "environment": "demo",
                    "symbol": "XAUUSD"
                }
            }),
        )
        .expect("save cli config");

        let stored: Value = serde_json::from_str(
            &fs::read_to_string(ctrader_config_path_for_root(&dir)).expect("read config"),
        )
        .expect("parse config");

        assert_eq!(
            stored.get("password").and_then(Value::as_str),
            Some("super-secret-password")
        );
        assert!(response.to_string().contains("passwordMasked"));
        assert!(!response.to_string().contains("super-secret-password"));
    }

    #[test]
    fn telegram_test_without_token_returns_safe_failure() {
        let dir = unique_temp_dir("telegram-test-missing");

        let response = test_telegram_for_root(
            &dir,
            &json!({
                "telegram": {
                    "enabled": true,
                    "botToken": "",
                    "chatId": "",
                    "timeoutSeconds": 10,
                    "levels": ["level_2"]
                }
            }),
        );

        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            response.get("status").and_then(Value::as_str),
            Some("failed")
        );
    }

    #[test]
    fn monitor_status_defaults_to_stopped() {
        let dir = unique_temp_dir("monitor-status");

        let status = read_monitor_status_for_root(&dir);

        assert_eq!(status.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(status.get("running").and_then(Value::as_bool), Some(false));
        assert_eq!(status.get("phase").and_then(Value::as_str), Some("stopped"));
    }

    #[test]
    fn monitor_status_strips_activity_unless_requested() {
        let dir = unique_temp_dir("monitor-status-lightweight");
        write_monitor_status_for_root(
            &dir,
            &json!({
                "ok": true,
                "available": true,
                "running": false,
                "phase": "stopped",
                "pid": null,
                "lastRunAt": "2026-05-26T05:00:00+08:00",
                "nextRunAt": null,
                "lastError": "",
                "message": "Monitor loop is stopped.",
                "activity": {
                    "llm": {
                        "status": "unavailable",
                        "jobs": [
                            {"title": "Cause review", "status": "unavailable"}
                        ]
                    }
                }
            }),
        )
        .expect("write status");

        let lightweight = read_monitor_status_for_root_with_activity(&dir, false);
        let full = read_monitor_status_for_root_with_activity(&dir, true);

        assert!(lightweight.get("activity").is_none());
        assert!(full.get("activity").is_some());
    }

    #[test]
    fn monitor_status_normalizes_old_stopped_error() {
        let dir = unique_temp_dir("monitor-old-stopped");
        write_monitor_status_for_root(
            &dir,
            &json!({
                "ok": false,
                "available": true,
                "running": false,
                "phase": "stopped",
                "pid": null,
                "monitorOwnerPid": 56872,
                "lastRunAt": "2026-05-26T04:59:26.482252+08:00",
                "nextRunAt": null,
                "lastError": "Saved monitor status referenced a process that is no longer running.",
                "message": "Monitor loop stopped unexpectedly.",
                "activity": {"llm": {"status": "unavailable"}}
            }),
        )
        .expect("write old monitor status");

        let status = read_monitor_status_for_root(&dir);
        let lightweight = read_monitor_status_for_root_with_activity(&dir, false);

        assert_eq!(status.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(status.get("running").and_then(Value::as_bool), Some(false));
        assert_eq!(status.get("phase").and_then(Value::as_str), Some("stopped"));
        assert_eq!(status.get("lastError").and_then(Value::as_str), Some(""));
        assert_eq!(
            status.get("message").and_then(Value::as_str),
            Some("Monitor loop is stopped.")
        );
        assert!(status.get("activity").is_some());
        assert!(lightweight.get("activity").is_none());
    }

    #[test]
    fn monitor_status_strips_legacy_csv_fallback_activity() {
        let dir = unique_temp_dir("monitor-legacy-csv-fallback");
        write_monitor_status_for_root(
            &dir,
            &json!({
                "ok": true,
                "available": true,
                "running": false,
                "phase": "stopped",
                "pid": null,
                "lastRunAt": "2026-05-26T04:59:26.482252+08:00",
                "nextRunAt": null,
                "lastError": "",
                "message": "Monitor loop is stopped.",
                "activity": {
                    "ctrader": {
                        "detail": "Live cTrader spot is unavailable. CSV fallback is debug/import only.",
                        "fallbackReason": "CSV fallback is debug/import only and is not used for live market conclusions.",
                        "jobs": [
                            {"title": "Live quote request", "status": "unavailable"},
                            {"title": "Ctrader Spot check", "status": "stale"},
                            {"title": "Yahoo Gc F Proxy check", "status": "unavailable"},
                            {"title": "Csv Fallback check", "status": "stale"}
                        ],
                        "providerChain": [
                            {"provider": "ctrader_spot", "source_type": "spot"},
                            {"provider": "csv_fallback", "source_type": "local_csv_fallback"}
                        ]
                    }
                }
            }),
        )
        .expect("write status");

        let status = read_monitor_status_for_root(&dir);
        let ctrader = status
            .get("activity")
            .and_then(|value| value.get("ctrader"))
            .expect("ctrader activity");
        let jobs = ctrader.get("jobs").and_then(Value::as_array).expect("jobs");
        let titles: Vec<&str> = jobs
            .iter()
            .filter_map(|item| item.get("title").and_then(Value::as_str))
            .collect();
        let providers: Vec<&str> = ctrader
            .get("providerChain")
            .and_then(Value::as_array)
            .expect("provider chain")
            .iter()
            .filter_map(|item| item.get("provider").and_then(Value::as_str))
            .collect();

        assert_eq!(
            ctrader.get("detail").and_then(Value::as_str),
            Some("Live cTrader spot is unavailable.")
        );
        assert_eq!(
            ctrader.get("fallbackReason").and_then(Value::as_str),
            Some("")
        );
        assert!(!titles.iter().any(|title| title.contains("Csv Fallback")));
        assert!(titles.contains(&"cTrader spot freshness"));
        assert!(titles.contains(&"GC=F proxy check"));
        assert!(!providers.contains(&"csv_fallback"));
    }

    #[test]
    fn monitor_loop_start_records_status_and_prevents_duplicate() {
        let dir = unique_temp_dir("monitor-start");

        let first = start_monitor_loop_for_root(&dir, 60, false);
        let second = start_monitor_loop_for_root(&dir, 60, false);

        assert_eq!(first.get("running").and_then(Value::as_bool), Some(true));
        assert_eq!(
            second.get("message").and_then(Value::as_str),
            Some("Monitor loop is already running.")
        );
        assert!(monitor_status_path_for_root(&dir).exists());
    }

    #[test]
    fn monitor_status_clears_dead_running_pid() {
        let dir = unique_temp_dir("monitor-dead-pid");
        write_monitor_status_for_root(
            &dir,
            &json!({
                "ok": true,
                "available": true,
                "running": true,
                "phase": "running",
                "pid": 99999999,
                "lastRunAt": null,
                "nextRunAt": 1779530659,
                "lastError": "",
                "message": "Monitor loop is running."
            }),
        )
        .expect("write status");
        let stale_mtime = FileTime::from_system_time(SystemTime::now() - Duration::from_secs(180));
        set_file_mtime(monitor_status_path_for_root(&dir), stale_mtime).expect("age status file");

        let status = read_monitor_status_for_root(&dir);

        assert_eq!(status.get("running").and_then(Value::as_bool), Some(false));
        assert_eq!(status.get("phase").and_then(Value::as_str), Some("stopped"));
        assert_eq!(
            status.get("message").and_then(Value::as_str),
            Some("Monitor loop is stopped.")
        );
        assert_eq!(status.get("lastError").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn monitor_status_normalizes_current_owner_dead_pid() {
        let dir = unique_temp_dir("monitor-current-owner-dead-pid");
        write_monitor_status_for_root(
            &dir,
            &json!({
                "ok": true,
                "available": true,
                "running": true,
                "phase": "running",
                "pid": 99999999,
                "monitorOwnerPid": std::process::id() as i64,
                "lastRunAt": null,
                "nextRunAt": 1779530659,
                "lastError": "",
                "message": "Monitor loop is running."
            }),
        )
        .expect("write status");
        let stale_mtime = FileTime::from_system_time(SystemTime::now() - Duration::from_secs(180));
        set_file_mtime(monitor_status_path_for_root(&dir), stale_mtime).expect("age status file");

        let status = read_monitor_status_for_root(&dir);

        assert_eq!(status.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(status.get("running").and_then(Value::as_bool), Some(false));
        assert_eq!(status.get("phase").and_then(Value::as_str), Some("stopped"));
        assert_eq!(
            status.get("message").and_then(Value::as_str),
            Some("Monitor loop is stopped.")
        );
        assert_eq!(status.get("lastError").and_then(Value::as_str), Some(""));
    }

    #[test]
    fn monitor_status_keeps_fresh_running_pid_without_probing() {
        let dir = unique_temp_dir("monitor-fresh-pid");
        write_monitor_status_for_root(
            &dir,
            &json!({
                "ok": true,
                "available": true,
                "running": true,
                "phase": "running",
                "pid": 99999999,
                "intervalSeconds": 60,
                "lastRunAt": null,
                "nextRunAt": 1,
                "lastError": "",
                "message": "Monitor loop is running."
            }),
        )
        .expect("write status");

        let status = read_monitor_status_for_root(&dir);

        assert_eq!(status.get("running").and_then(Value::as_bool), Some(true));
        assert_eq!(status.get("phase").and_then(Value::as_str), Some("running"));
        assert_eq!(
            status.get("message").and_then(Value::as_str),
            Some("Monitor loop is running.")
        );
    }

    #[test]
    fn monitor_status_marks_activity_stale_when_timeline_has_newer_run() {
        let dir = unique_temp_dir("monitor-status-timeline-sync");
        seed_timeline_db(&timeline_path_for_root(&dir));
        write_monitor_status_for_root(
            &dir,
            &json!({
                "ok": true,
                "available": true,
                "running": false,
                "phase": "stopped",
                "pid": null,
                "latestMonitorRunId": 0,
                "lastRunAt": "2026-05-18T08:00:00+08:00",
                "lastError": "",
                "message": "Monitor loop is stopped.",
                "activity": {
                    "ctrader": {
                        "status": "unavailable",
                        "detail": "Old trace"
                    }
                }
            }),
        )
        .expect("write stale status");

        let status = read_monitor_status_for_root(&dir);

        assert_eq!(
            status.get("latestMonitorRunId").and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            status.get("latestStoredRunAt").and_then(Value::as_str),
            Some("2026-05-19T08:00:00+08:00")
        );
        assert_eq!(
            status.get("activityStale").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            status.get("lastRunAt").and_then(Value::as_str),
            Some("2026-05-19T08:00:00+08:00")
        );
    }

    #[test]
    fn running_monitor_without_owner_pid_is_not_reused_when_spawning() {
        let app_pid = std::process::id() as i64;
        let current = json!({
            "running": true,
            "pid": 99999999,
            "message": "Monitor loop is already running."
        });

        assert_eq!(should_reuse_running_monitor(&current, true, app_pid), false);
    }

    #[test]
    fn running_monitor_with_matching_owner_pid_is_reused() {
        let app_pid = std::process::id() as i64;
        let current = json!({
            "running": true,
            "pid": 12345,
            "monitorOwnerPid": app_pid,
            "message": "Monitor loop is already running."
        });

        assert_eq!(should_reuse_running_monitor(&current, true, app_pid), true);
    }

    #[test]
    fn monitor_command_passes_status_path_to_python() {
        let dir = unique_temp_dir("monitor-command-status-env");

        let command = monitor_command_base(&dir);
        let status_env = command
            .get_envs()
            .find(|(key, _)| key.to_string_lossy() == "MARKET_AGENT_MONITOR_STATUS_PATH")
            .and_then(|(_, value)| value.map(|item| item.to_string_lossy().to_string()));

        assert_eq!(
            status_env,
            Some(
                monitor_status_path_for_root(&dir)
                    .to_string_lossy()
                    .to_string()
            )
        );
    }

    #[test]
    fn monitor_command_uses_windowless_python_on_windows() {
        #[cfg(target_os = "windows")]
        assert_eq!(monitor_python_program(), "pythonw");

        #[cfg(not(target_os = "windows"))]
        assert_eq!(monitor_python_program(), "python");
    }

    #[test]
    fn monitor_loop_stop_records_stopped_status() {
        let dir = unique_temp_dir("monitor-stop");
        let _ = start_monitor_loop_for_root(&dir, 60, false);

        let stopped = stop_monitor_loop_for_root(&dir, false);

        assert_eq!(stopped.get("running").and_then(Value::as_bool), Some(false));
        assert_eq!(
            stopped.get("phase").and_then(Value::as_str),
            Some("stopped")
        );
    }

    #[test]
    fn backfill_recovery_records_recovery_status() {
        let dir = unique_temp_dir("monitor-recovery");

        let status = run_backfill_recovery_for_root(&dir, false);
        let saved = read_monitor_status_for_root(&dir);

        assert_eq!(status.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            saved.get("phase").and_then(Value::as_str),
            Some("recovery_completed")
        );
        assert!(saved.get("lastRecoveryAt").is_some());
    }
}
