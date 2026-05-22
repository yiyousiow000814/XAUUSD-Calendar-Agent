use crate::config;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

type LatestMonitorRun = (i64, String, String);
type LatestPayloadRows = (Option<i64>, Option<String>, Vec<Value>);
static CANCEL_OLLAMA_PULL: AtomicBool = AtomicBool::new(false);
const DEFAULT_OLLAMA_ENDPOINT: &str = "http://localhost:11434";

fn repo_root_from_manifest() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.parent()?.parent()?.parent().map(Path::to_path_buf)
}

fn candidate_roots() -> Vec<PathBuf> {
    let cfg = config::load_config();
    let mut roots = vec![config::appdata_dir(), config::working_root_dir(&cfg)];
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.clone());
        roots.push(cwd.join("user-data"));
    }
    roots.push(config::install_dir());
    roots.push(config::install_dir().join("user-data"));
    if let Some(repo_root) = repo_root_from_manifest() {
        roots.push(repo_root.clone());
        roots.push(repo_root.join("user-data"));
    }
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

fn ctrader_config_path_for_root(root: &Path) -> PathBuf {
    root.join("ctrader-cli.json")
}

fn telegram_config_path_for_root(root: &Path) -> PathBuf {
    root.join("market-agent-telegram.json")
}

fn llm_config_path_for_root(root: &Path) -> PathBuf {
    root.join("market-agent-llm.json")
}

fn read_json_object(path: &Path) -> serde_json::Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
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
    let config_payload = read_json_object(&config_path);
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
        .unwrap_or_else(|| root.join("ctrader-last-quote.json").display().to_string());
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
        "allowSavedSnapshotFallback": get_bool("allowSavedSnapshotFallback", true),
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
            "allowSavedSnapshotFallback": merged.get("allowSavedSnapshotFallback").and_then(Value::as_bool).unwrap_or(true),
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
        "allowSavedSnapshotFallback": merged.get("allowSavedSnapshotFallback").and_then(Value::as_bool).unwrap_or(true),
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
        "endpoint": get_str("endpoint", "http://localhost:11434"),
        "model": get_str("model", "qwen3.5:4b"),
        "temperature": get_f64("temperature", 0.1),
        "timeoutSeconds": get_i64("timeoutSeconds", 20),
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
            "endpoint": merged.get("endpoint").and_then(Value::as_str).unwrap_or("http://localhost:11434"),
            "model": merged.get("model").and_then(Value::as_str).unwrap_or("qwen3.5:4b"),
            "temperature": merged.get("temperature").and_then(Value::as_f64).unwrap_or(0.1),
            "timeoutSeconds": merged.get("timeoutSeconds").and_then(Value::as_i64).unwrap_or(20),
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
        merged
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or("http://localhost:11434")
            .to_string(),
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
            .unwrap_or(0.1)
            .to_string(),
    );
    env.insert(
        "LOCAL_LLM_TIMEOUT_SECONDS".to_string(),
        merged
            .get("timeoutSeconds")
            .and_then(Value::as_i64)
            .unwrap_or(20)
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

fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn detect_system_profile_value() -> Value {
    let logical_cpu_count = std::thread::available_parallelism()
        .map(|value| value.get() as i64)
        .unwrap_or(0);
    let cpu = std::env::var("PROCESSOR_IDENTIFIER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| command_stdout("wmic", &["cpu", "get", "name", "/value"]))
        .unwrap_or_else(|| "Unknown CPU".to_string())
        .replace("Name=", "")
        .trim()
        .to_string();
    let ram_bytes = command_stdout(
        "powershell",
        &[
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
        ],
    )
    .and_then(|text| text.lines().last().unwrap_or("").trim().parse::<i64>().ok())
    .unwrap_or(0);
    let gpu_json = command_stdout(
        "powershell",
        &[
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,AdapterRAM | ConvertTo-Json -Compress",
        ],
    )
    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    .unwrap_or_else(|| json!({}));
    let gpu_name = gpu_json
        .get("Name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let vram_bytes = gpu_json
        .get("AdapterRAM")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
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
    })
}

fn endpoint_from_payload(payload: &Value) -> String {
    payload
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
        .to_string()
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

fn check_ollama_installed_value() -> Value {
    match Command::new("ollama").arg("--version").output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            json!({
                "ok": true,
                "installed": true,
                "status": "installed",
                "version": version,
                "message": "Ollama is installed."
            })
        }
        Ok(output) => json!({
            "ok": false,
            "installed": false,
            "status": "ollama_not_installed",
            "error": String::from_utf8_lossy(&output.stderr).trim().to_string(),
            "installerUrl": "https://ollama.com/download",
            "message": "Ollama is not installed. Install Ollama first, then return here."
        }),
        Err(err) => json!({
            "ok": false,
            "installed": false,
            "status": "ollama_not_installed",
            "error": err.to_string(),
            "installerUrl": "https://ollama.com/download",
            "message": "Ollama is not installed. Install Ollama first, then return here."
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
                "status": "ollama_running",
                "endpoint": endpoint,
                "version": payload.get("version").and_then(Value::as_str).unwrap_or(""),
                "message": "Ollama endpoint is reachable."
            })
        }
        Err(err) => json!({
            "ok": false,
            "running": false,
            "endpointReachable": false,
            "status": "ollama_not_running",
            "endpoint": endpoint,
            "error": err.to_string(),
            "message": "Ollama is installed but not running, or the endpoint is not reachable."
        }),
    }
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
            "status": "ollama_not_running",
            "endpoint": endpoint,
            "models": [],
            "modelNames": [],
            "error": err.to_string(),
        }),
    }
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
            "status": "ollama_not_installed",
            "message": "Ollama is not installed. Install Ollama manually, then return to install the recommended model.",
            "system": profile,
            "ollama": {
                "installed": false,
                "running": false,
                "endpointReachable": false,
                "endpoint": endpoint,
                "installerUrl": "https://ollama.com/download"
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
        return json!({
            "ok": true,
            "available": true,
            "status": "ollama_not_running",
            "message": "Ollama is installed but not running. Start Ollama, then return here.",
            "system": profile,
            "ollama": {
                "installed": true,
                "running": false,
                "endpointReachable": false,
                "endpoint": endpoint,
                "version": installed.get("version").and_then(Value::as_str).unwrap_or("")
            },
            "installedModels": [],
            "recommendedModel": recommended,
            "profiles": local_model_profiles(),
            "fallbackChain": fallback_chain,
            "ruleBasedActive": true,
            "llm": masked_llm_config_for_root(root).get("llm").cloned().unwrap_or(Value::Null),
        });
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
    let recommended_name = recommended
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let model_ready = model_names.iter().any(|name| name == recommended_name);
    json!({
        "ok": true,
        "available": true,
        "status": if model_ready { "model_ready" } else { "model_missing" },
        "message": if model_ready { "Recommended model is installed." } else { "Recommended model is missing." },
        "system": profile,
        "ollama": {
            "installed": true,
            "running": true,
            "endpointReachable": true,
            "endpoint": endpoint,
            "version": running.get("version").and_then(Value::as_str).unwrap_or("")
        },
        "installedModels": model_list.get("models").cloned().unwrap_or_else(|| json!([])),
        "recommendedModel": recommended,
        "profiles": local_model_profiles(),
        "fallbackChain": fallback_chain,
        "ruleBasedActive": true,
        "llm": masked_llm_config_for_root(root).get("llm").cloned().unwrap_or(Value::Null),
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

fn run_ollama_pull(app: &tauri::AppHandle, payload: &Value) -> Value {
    let endpoint = endpoint_from_payload(payload);
    let model = model_from_payload(payload);
    CANCEL_OLLAMA_PULL.store(false, Ordering::SeqCst);
    let url = format!("{}/api/pull", endpoint.trim_end_matches('/'));
    let response = match ureq::post(&url)
        .timeout(Duration::from_secs(60 * 60))
        .send_json(json!({ "name": model, "stream": true }))
    {
        Ok(response) => response,
        Err(err) => {
            return json!({
                "ok": false,
                "status": "download_failed",
                "model": model,
                "error": err.to_string(),
            })
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
        if CANCEL_OLLAMA_PULL.load(Ordering::SeqCst) {
            let cancelled = json!({
                "ok": false,
                "status": "cancelled",
                "model": model,
                "message": "Model download cancelled.",
            });
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
            "message": "Model download completed, but Ollama did not report the model in the local model list.",
            "progress": last_progress,
        });
    }

    let validation_payload = json!({
        "endpoint": endpoint,
        "model": model,
        "timeoutSeconds": payload.get("timeoutSeconds").and_then(Value::as_i64).unwrap_or(20),
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
        .unwrap_or(20)
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
    let mut child = match Command::new("python")
        .args(["-m", "src.xauusd_market_agent.llm_bridge", mode])
        .current_dir(workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            return json!({
                "ok": false,
                "status": "unavailable",
                "error": format!("Unable to start LLM bridge: {err}"),
                "llm": masked_llm_config_for_root(root).get("llm").cloned().unwrap_or(Value::Null),
            })
        }
    };
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(merged.to_string().as_bytes());
    }
    let parsed = match child.wait_with_output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
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
    env.insert(
        "CTRADER_CONFIG_PATH".to_string(),
        ctrader_config_path_for_root(root).display().to_string(),
    );
    env.insert(
        "MARKET_AGENT_CTRADER_SAVED_SNAPSHOT_PATH".to_string(),
        root.join("ctrader-last-quote.json").display().to_string(),
    );
    env
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
    let mut child = match Command::new("python")
        .args(["-m", "src.xauusd_market_agent.telegram_bridge"])
        .current_dir(workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            return json!({
                "ok": false,
                "status": "failed",
                "error": format!("Unable to start Telegram bridge: {err}"),
                "telegram": masked_telegram_config_for_root(root).get("telegram").cloned().unwrap_or(Value::Null),
            })
        }
    };
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(merged.to_string().as_bytes());
    }
    let parsed = match child.wait_with_output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if !output.status.success() {
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
            "error": format!("Unable to wait for Telegram bridge: {err}"),
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
        "message": parsed.get("message").and_then(Value::as_str).unwrap_or("Telegram test completed."),
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

fn run_ctrader_bridge(root: &Path, command: &str, payload: &Value) -> Value {
    let merged = merged_ctrader_provider_config(root, Some(payload));
    let workdir = repo_root_from_manifest()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| root.to_path_buf());
    let mut child = match Command::new("python")
        .args([
            "-m",
            "src.xauusd_market_agent.providers.ctrader_bridge",
            command,
        ])
        .current_dir(workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            return json!({
                "ok": false,
                "error": format!("Unable to start cTrader CLI adapter: {err}"),
            })
        }
    };
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(merged.to_string().as_bytes());
    }
    match child.wait_with_output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if !output.status.success() {
                return json!({
                    "ok": false,
                    "error": if stderr.is_empty() { stdout } else { stderr },
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

fn read_monitor_status_for_root(root: &Path) -> Value {
    read_json_file(&monitor_status_path_for_root(root)).unwrap_or_else(|| {
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
    })
}

fn write_monitor_status_for_root(root: &Path, status: &Value) -> Result<(), String> {
    write_json_atomic(&monitor_status_path_for_root(root), status)
}

fn repo_root_for_monitor(root: &Path) -> PathBuf {
    repo_root_from_manifest()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| root.to_path_buf())
}

fn monitor_command_base(root: &Path) -> Command {
    let mut command = Command::new("python");
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
    command
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
    if current
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
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
        match command.spawn() {
            Ok(child) => child.id() as i64,
            Err(err) => {
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
            Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output()
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
        "available": true,
        "running": false,
        "phase": if last_error.is_empty() { "stopped" } else { "error" },
        "pid": null,
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
    let status = match output {
        Ok(output) if output.status.success() => json!({
            "ok": true,
            "available": true,
            "running": false,
            "phase": "stopped",
            "pid": null,
            "lastRunAt": now,
            "nextRunAt": null,
            "lastError": "",
            "message": "Monitor run completed.",
        }),
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
            "SELECT id, run_started_at, data_mode FROM monitor_runs ORDER BY id DESC LIMIT 1",
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
}

#[tauri::command]
pub fn get_market_agent_provider_health(_payload: Value) -> Value {
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let timeline_path = timeline_path_for_root(&root);
    let connection = match open_timeline_db(&root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_payload(&message, Some(&root)),
    };
    match read_provider_health_latest(&connection) {
        Ok((monitor_run_id, run_started_at, items)) => json!({
            "ok": true,
            "available": timeline_path.exists(),
            "timeline_store_path": timeline_path.display().to_string(),
            "monitor_run_id": monitor_run_id,
            "run_started_at": run_started_at,
            "items": items,
        }),
        Err(err) => build_unavailable_payload(
            &format!("Unable to read provider health: {err}"),
            Some(&root),
        ),
    }
}

#[tauri::command]
pub fn get_market_agent_driver_attention(_payload: Value) -> Value {
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
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
    let monitor_run_id = payload
        .get("monitorRunId")
        .or_else(|| payload.get("monitor_run_id"))
        .and_then(|v| v.as_i64())
        .unwrap_or_default();
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
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
}

#[tauri::command]
pub fn get_market_agent_replay(payload: Value) -> Value {
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let start = payload.get("start").and_then(|v| v.as_str()).unwrap_or("");
    let end = payload.get("end").and_then(|v| v.as_str()).unwrap_or("");
    read_market_agent_replay(&root, start, end)
}

#[tauri::command]
pub fn get_market_agent_provider_config(_payload: Value) -> Value {
    masked_ctrader_provider_config(&config::appdata_dir())
}

#[tauri::command]
pub fn save_market_agent_provider_config(payload: Value) -> Value {
    match save_ctrader_provider_config(&config::appdata_dir(), &payload) {
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
    masked_telegram_config_for_root(&config::appdata_dir())
}

#[tauri::command]
pub fn get_market_agent_llm_config(_payload: Value) -> Value {
    masked_llm_config_for_root(&config::appdata_dir())
}

#[tauri::command]
pub fn save_market_agent_telegram_config(payload: Value) -> Value {
    match save_telegram_config_for_root(&config::appdata_dir(), &payload) {
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
    match save_llm_config_for_root(&config::appdata_dir(), &payload) {
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
    test_telegram_for_root(&config::appdata_dir(), &payload)
}

#[tauri::command]
pub fn test_market_agent_llm_connection(payload: Value) -> Value {
    test_llm_for_root(&config::appdata_dir(), &payload, "connection")
}

#[tauri::command]
pub fn test_market_agent_llm_json_response(payload: Value) -> Value {
    test_llm_for_root(&config::appdata_dir(), &payload, "json")
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
    detect_local_ai_setup_value(&config::appdata_dir(), &payload)
}

#[tauri::command]
pub fn pull_ollama_model(app: tauri::AppHandle, payload: Value) -> Value {
    run_ollama_pull(&app, &payload)
}

#[tauri::command]
pub fn cancel_model_download(_payload: Value) -> Value {
    CANCEL_OLLAMA_PULL.store(true, Ordering::SeqCst);
    json!({
        "ok": true,
        "status": "cancelling",
        "message": "Cancelling model download."
    })
}

#[tauri::command]
pub fn test_llm_json(payload: Value) -> Value {
    test_llm_for_root(&config::appdata_dir(), &payload, "json")
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
    match clear_ctrader_provider_config(&config::appdata_dir()) {
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
    run_ctrader_bridge(&config::appdata_dir(), "test-connection", &payload)
}

#[tauri::command]
pub fn resolve_ctrader_symbol(payload: Value) -> Value {
    run_ctrader_bridge(&config::appdata_dir(), "resolve-symbol", &payload)
}

#[tauri::command]
pub fn get_ctrader_quote_test(payload: Value) -> Value {
    run_ctrader_bridge(&config::appdata_dir(), "quote", &payload)
}

#[tauri::command]
pub fn start_ctrader_connect(payload: Value) -> Value {
    let root = config::appdata_dir();
    let mut merged = merged_ctrader_provider_config(&root, Some(&payload));
    merged["enabled"] = Value::Bool(true);
    match save_ctrader_provider_config(&root, &json!({"ctrader": merged})) {
        Ok(_) => {
            let result = run_ctrader_bridge(&root, "test-connection", &payload);
            if result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                json!({
                    "ok": true,
                    "status": "connected",
                    "message": result.get("message").and_then(Value::as_str).unwrap_or("cTrader CLI credentials saved and checked."),
                    "account": result.get("account").cloned().unwrap_or(Value::Null),
                    "symbol": result.get("symbol").cloned().unwrap_or(Value::Null),
                    "provider_health": result.get("provider_health").cloned().unwrap_or(Value::Null),
                    "ctrader": masked_ctrader_provider_config(&root).get("ctrader").cloned().unwrap_or(Value::Null),
                })
            } else {
                json!({
                    "ok": false,
                    "status": "connection_failed",
                    "message": "cTrader CLI credentials were saved, but the connection check failed.",
                    "error": result.get("error").and_then(Value::as_str).unwrap_or("cTrader CLI connection failed."),
                    "ctrader": masked_ctrader_provider_config(&root).get("ctrader").cloned().unwrap_or(Value::Null),
                })
            }
        }
        Err(err) => json!({
            "ok": false,
            "status": "save_failed",
            "error": err,
        }),
    }
}

#[tauri::command]
pub fn test_ctrader_backfill(payload: Value) -> Value {
    test_ctrader_backfill_for_root(&config::appdata_dir(), &payload)
}

#[tauri::command]
pub fn get_market_agent_monitor_status(_payload: Value) -> Value {
    read_monitor_status_for_root(&config::appdata_dir())
}

#[tauri::command]
pub fn run_market_agent_monitor_once(_payload: Value) -> Value {
    run_monitor_once_for_root(&config::appdata_dir())
}

#[tauri::command]
pub fn run_market_agent_backfill_recovery(_payload: Value) -> Value {
    run_backfill_recovery_for_root(&config::appdata_dir(), true)
}

#[tauri::command]
pub fn start_market_agent_monitor_loop(payload: Value) -> Value {
    let interval_seconds = payload
        .get("intervalSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(60)
        .max(10);
    start_monitor_loop_for_root(&config::appdata_dir(), interval_seconds, true)
}

#[tauri::command]
pub fn stop_market_agent_monitor_loop(_payload: Value) -> Value {
    stop_monitor_loop_for_root(&config::appdata_dir(), true)
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
    let news_items = read_range_payloads(&connection, "news_items", "published_at", start, end)
        .unwrap_or_default();
    let calendar_events =
        read_range_payloads(&connection, "calendar_events", "scheduled_at", start, end)
            .unwrap_or_default();
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
            "state_transitions": state_transitions,
            "alerts": alerts,
            "suppressed_alerts": suppressed_alerts,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{
        apply_llm_fallback_policy_for_result, clear_ctrader_provider_config,
        ctrader_config_path_for_root, ctrader_env_for_root, llm_config_path_for_root,
        llm_env_for_root, mask_secret, masked_ctrader_provider_config, masked_llm_config_for_root,
        masked_telegram_config_for_root, monitor_status_path_for_root,
        normalize_pull_progress_line, read_json_object, read_market_agent_replay,
        read_market_agent_snapshot, read_monitor_status_for_root,
        recommend_local_model_from_profile, run_backfill_recovery_for_root,
        save_ctrader_provider_config, save_llm_config_for_root, save_telegram_config_for_root,
        start_monitor_loop_for_root, stop_monitor_loop_for_root, telegram_config_path_for_root,
        telegram_env_for_root, test_telegram_for_root, timeline_path_for_root,
    };
    use rusqlite::{params, Connection};
    use serde_json::{json, Value};
    use std::fs;
    use std::path::PathBuf;

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
                "temperature": 0.1,
                "timeoutSeconds": 20,
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
            env.get("LOCAL_LLM_ENABLED").map(String::as_str),
            Some("true")
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
