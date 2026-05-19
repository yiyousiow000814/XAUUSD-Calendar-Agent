use crate::config;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

type LatestMonitorRun = (i64, String, String);
type LatestPayloadRows = (Option<i64>, Option<String>, Vec<Value>);

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
    root.join("ctrader-openapi.json")
}

fn ctrader_token_store_path_for_root(root: &Path) -> PathBuf {
    root.join("ctrader-token.json")
}

fn telegram_config_path_for_root(root: &Path) -> PathBuf {
    root.join("market-agent-telegram.json")
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
    if trimmed.len() <= 4 {
        return "*".repeat(trimmed.len());
    }
    format!(
        "{}{}{}",
        &trimmed[..2],
        "*".repeat(std::cmp::max(4, trimmed.len().saturating_sub(4))),
        &trimmed[trimmed.len() - 2..]
    )
}

fn merged_ctrader_provider_config(root: &Path, override_payload: Option<&Value>) -> Value {
    let config_path = ctrader_config_path_for_root(root);
    let config_payload = read_json_object(&config_path);
    let token_store_path = override_payload
        .and_then(|payload| payload.get("tokenStorePath"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            config_payload
                .get("tokenStorePath")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| ctrader_token_store_path_for_root(root))
        });
    let token_payload = read_json_object(&token_store_path);
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
            .or_else(|| token_payload.get(key).and_then(Value::as_str))
            .unwrap_or("")
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
    let bridge_python = {
        let value = get_str("bridgePythonExecutable");
        if value.is_empty() {
            "python".to_string()
        } else {
            value
        }
    };
    json!({
        "enabled": get_bool("enabled", false),
        "clientId": get_str("clientId"),
        "clientSecret": get_str("clientSecret"),
        "accessToken": get_str("accessToken"),
        "refreshToken": get_str("refreshToken"),
        "accountId": get_str("accountId"),
        "environment": environment,
        "symbol": symbol,
        "symbolId": get_i64("symbolId"),
        "appRedirectUri": get_str("appRedirectUri"),
        "tokenStorePath": token_store_path.display().to_string(),
        "snapshotPath": snapshot_path,
        "quoteTimeoutSeconds": get_i64("quoteTimeoutSeconds").unwrap_or(8),
        "quoteStaleAfterSeconds": get_i64("quoteStaleAfterSeconds").unwrap_or(15),
        "allowSavedSnapshotFallback": get_bool("allowSavedSnapshotFallback", true),
        "bridgePythonExecutable": bridge_python,
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
            "clientIdMasked": mask_secret(merged.get("clientId").and_then(Value::as_str).unwrap_or("")),
            "clientSecretMasked": mask_secret(merged.get("clientSecret").and_then(Value::as_str).unwrap_or("")),
            "accessTokenMasked": mask_secret(merged.get("accessToken").and_then(Value::as_str).unwrap_or("")),
            "refreshTokenMasked": mask_secret(merged.get("refreshToken").and_then(Value::as_str).unwrap_or("")),
            "hasAccessToken": !merged.get("accessToken").and_then(Value::as_str).unwrap_or("").trim().is_empty(),
            "hasRefreshToken": !merged.get("refreshToken").and_then(Value::as_str).unwrap_or("").trim().is_empty(),
            "appRedirectUri": merged.get("appRedirectUri").and_then(Value::as_str).unwrap_or(""),
            "tokenStorePath": merged.get("tokenStorePath").and_then(Value::as_str).unwrap_or(""),
            "snapshotPath": merged.get("snapshotPath").and_then(Value::as_str).unwrap_or(""),
            "quoteTimeoutSeconds": merged.get("quoteTimeoutSeconds").and_then(Value::as_i64).unwrap_or(8),
            "quoteStaleAfterSeconds": merged.get("quoteStaleAfterSeconds").and_then(Value::as_i64).unwrap_or(15),
            "allowSavedSnapshotFallback": merged.get("allowSavedSnapshotFallback").and_then(Value::as_bool).unwrap_or(true),
            "bridgePythonExecutable": merged.get("bridgePythonExecutable").and_then(Value::as_str).unwrap_or("python"),
            "configPath": merged.get("configPath").and_then(Value::as_str).unwrap_or(""),
        }
    })
}

fn save_ctrader_provider_config(root: &Path, payload: &Value) -> Result<Value, String> {
    let merged = merged_ctrader_provider_config(root, Some(payload));
    let config_path = ctrader_config_path_for_root(root);
    let token_store_path = PathBuf::from(
        merged
            .get("tokenStorePath")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                ctrader_token_store_path_for_root(root)
                    .display()
                    .to_string()
            }),
    );
    let config_payload = json!({
        "enabled": merged.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "clientId": merged.get("clientId").and_then(Value::as_str).unwrap_or(""),
        "accountId": merged.get("accountId").and_then(Value::as_str).unwrap_or(""),
        "environment": merged.get("environment").and_then(Value::as_str).unwrap_or("demo"),
        "symbol": merged.get("symbol").and_then(Value::as_str).unwrap_or("XAUUSD"),
        "symbolId": merged.get("symbolId").cloned().unwrap_or(Value::Null),
        "appRedirectUri": merged.get("appRedirectUri").and_then(Value::as_str).unwrap_or(""),
        "tokenStorePath": token_store_path.display().to_string(),
        "snapshotPath": merged.get("snapshotPath").and_then(Value::as_str).unwrap_or(""),
        "quoteTimeoutSeconds": merged.get("quoteTimeoutSeconds").and_then(Value::as_i64).unwrap_or(8),
        "quoteStaleAfterSeconds": merged.get("quoteStaleAfterSeconds").and_then(Value::as_i64).unwrap_or(15),
        "allowSavedSnapshotFallback": merged.get("allowSavedSnapshotFallback").and_then(Value::as_bool).unwrap_or(true),
        "bridgePythonExecutable": merged.get("bridgePythonExecutable").and_then(Value::as_str).unwrap_or("python"),
    });
    let token_payload = json!({
        "clientSecret": merged.get("clientSecret").and_then(Value::as_str).unwrap_or(""),
        "accessToken": merged.get("accessToken").and_then(Value::as_str).unwrap_or(""),
        "refreshToken": merged.get("refreshToken").and_then(Value::as_str).unwrap_or(""),
    });
    write_json_atomic(&config_path, &config_payload)?;
    write_json_atomic(&token_store_path, &token_payload)?;
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
        "botToken": get_str("botToken"),
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
    let token_store_path = read_json_object(&config_path)
        .get("tokenStorePath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| ctrader_token_store_path_for_root(root));
    let _ = fs::remove_file(config_path);
    let _ = fs::remove_file(token_store_path);
    Ok(masked_ctrader_provider_config(root))
}

fn write_refreshed_ctrader_tokens(root: &Path, bridge_response: &Value) -> Result<Value, String> {
    let token_store_path = merged_ctrader_provider_config(root, None)
        .get("tokenStorePath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| ctrader_token_store_path_for_root(root));
    let access_token = bridge_response
        .get("accessToken")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if access_token.is_empty() {
        return Err(
            "cTrader refresh-token response did not include a new access token.".to_string(),
        );
    }
    let refresh_token = bridge_response
        .get("refreshToken")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let existing = read_json_object(&token_store_path);
    let payload = json!({
        "clientSecret": existing.get("clientSecret").and_then(Value::as_str).unwrap_or(""),
        "accessToken": access_token,
        "refreshToken": if refresh_token.is_empty() {
            existing.get("refreshToken").and_then(Value::as_str).unwrap_or("")
        } else {
            refresh_token.as_str()
        },
    });
    write_json_atomic(&token_store_path, &payload)?;
    Ok(token_store_path.display().to_string().into())
}

fn run_ctrader_bridge(root: &Path, command: &str, payload: &Value) -> Value {
    let merged = merged_ctrader_provider_config(root, Some(payload));
    let python = merged
        .get("bridgePythonExecutable")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("python");
    let workdir = repo_root_from_manifest()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| root.to_path_buf());
    let mut child = match Command::new(python)
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
                "error": format!("Unable to start cTrader bridge: {err}"),
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
                    "error": format!("Unable to parse cTrader bridge JSON: {err}"),
                    "raw": stdout,
                })
            });
            if command == "refresh-token"
                && parsed.get("ok").and_then(Value::as_bool).unwrap_or(false)
            {
                match write_refreshed_ctrader_tokens(root, &parsed) {
                    Ok(token_store_path) => {
                        return json!({
                            "ok": true,
                            "message": "cTrader access token refreshed and saved.",
                            "tokenStorePath": token_store_path,
                            "provider_health": parsed.get("provider_health").cloned().unwrap_or(Value::Null),
                            "ctrader": masked_ctrader_provider_config(root)
                                .get("ctrader")
                                .cloned()
                                .unwrap_or(Value::Null),
                        });
                    }
                    Err(err) => {
                        return json!({
                            "ok": false,
                            "error": err,
                        });
                    }
                }
            }
            parsed
        }
        Err(err) => json!({
            "ok": false,
            "error": format!("Unable to wait for cTrader bridge: {err}"),
        }),
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
pub fn test_market_agent_telegram(payload: Value) -> Value {
    test_telegram_for_root(&config::appdata_dir(), &payload)
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
pub fn refresh_ctrader_token(payload: Value) -> Value {
    run_ctrader_bridge(&config::appdata_dir(), "refresh-token", &payload)
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
        Err(message) => return build_unavailable_payload(&message, Some(root)),
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
            return build_unavailable_payload(
                &format!("Unable to read market replay price series: {err}"),
                Some(root),
            )
        }
    };
    let related_assets = match read_related_assets_map(&connection, start, end) {
        Ok(rows) => rows,
        Err(err) => {
            return build_unavailable_payload(
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
        clear_ctrader_provider_config, ctrader_config_path_for_root,
        ctrader_token_store_path_for_root, masked_ctrader_provider_config,
        masked_telegram_config_for_root, monitor_status_path_for_root, read_market_agent_replay,
        read_market_agent_snapshot, read_monitor_status_for_root, save_ctrader_provider_config,
        save_telegram_config_for_root, start_monitor_loop_for_root, stop_monitor_loop_for_root,
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
                "clientId": "client-id",
                "clientSecret": "client-secret",
                "accessToken": "access-token",
                "refreshToken": "refresh-token",
                "accountId": "123456",
                "symbol": "XAUUSD",
                "symbolId": 777,
                "snapshotPath": dir.join("ctrader-last-quote.json").display().to_string(),
                "tokenStorePath": dir.join("ctrader-token.json").display().to_string(),
                "quoteTimeoutSeconds": 9,
                "quoteStaleAfterSeconds": 15,
                "allowSavedSnapshotFallback": true,
                "bridgePythonExecutable": "python"
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
                .and_then(|value| value.get("clientSecretMasked"))
                .and_then(Value::as_str),
            Some("client-secret")
        );
        assert!(ctrader_config_path_for_root(&dir).exists());
        assert!(ctrader_token_store_path_for_root(&dir).exists());
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
            ctrader_token_store_path_for_root(&dir),
            json!({"accessToken": "secret"}).to_string(),
        )
        .expect("write token store");

        let response = clear_ctrader_provider_config(&dir).expect("clear config");

        assert_eq!(response.get("ok").and_then(Value::as_bool), Some(true));
        assert!(!ctrader_config_path_for_root(&dir).exists());
        assert!(!ctrader_token_store_path_for_root(&dir).exists());
    }

    #[test]
    fn refreshed_ctrader_tokens_are_saved_without_returning_raw_secret_values() {
        let dir = unique_temp_dir("ctrader-refresh");
        save_ctrader_provider_config(
            &dir,
            &json!({
                "ctrader": {
                    "enabled": true,
                    "environment": "demo",
                    "clientId": "client-id",
                    "clientSecret": "client-secret",
                    "accessToken": "old-access-token",
                    "refreshToken": "old-refresh-token",
                    "accountId": "123456",
                    "symbol": "XAUUSD",
                    "tokenStorePath": dir.join("ctrader-token.json").display().to_string(),
                    "snapshotPath": dir.join("ctrader-last-quote.json").display().to_string(),
                }
            }),
        )
        .expect("seed config");

        let response = json!({
            "ok": true,
            "accessToken": "new-access-token",
            "refreshToken": "new-refresh-token",
            "provider_health": {
                "source": "cTrader",
                "source_type": "spot",
                "data_mode": "live_seen",
                "is_available": true,
                "is_stale": false,
            }
        });
        let token_store_path =
            super::write_refreshed_ctrader_tokens(&dir, &response).expect("write refreshed tokens");
        let stored: Value = serde_json::from_str(
            &fs::read_to_string(ctrader_token_store_path_for_root(&dir)).expect("read token store"),
        )
        .expect("parse token store");

        assert_eq!(
            token_store_path.as_str(),
            Some(
                dir.join("ctrader-token.json")
                    .display()
                    .to_string()
                    .as_str()
            )
        );
        assert_eq!(
            stored.get("accessToken").and_then(Value::as_str),
            Some("new-access-token")
        );
        assert_eq!(
            stored.get("refreshToken").and_then(Value::as_str),
            Some("new-refresh-token")
        );
        let masked = masked_ctrader_provider_config(&dir);
        assert!(
            masked.to_string().contains("accessTokenMasked"),
            "masked payload should expose masked token fields"
        );
        assert!(!masked.to_string().contains("new-access-token"));
        assert!(!masked.to_string().contains("new-refresh-token"));
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
}
