use serde_json::Value;

#[derive(Default)]
pub struct CalendarCache {
    pub status: String,
    pub last_loaded_at_ms: i64,
    pub events: Vec<Value>,
}

#[derive(Default)]
pub struct RuntimeState {
    pub logs: Vec<Value>,
    pub currency: String,
    pub pull_active: bool,
    pub sync_active: bool,
    pub boot_logged: bool,
    pub auto_pull_started: bool,
    pub auto_update_check_started: bool,
    pub token_check_started: bool,
    pub last_pull: String,
    pub last_pull_at: String,
    pub last_sync: String,
    pub last_sync_at: String,
    pub update_state: Value,
    pub update_release_url: String,
    pub update_asset_url: String,
    pub output_dir: String,
    pub repo_path: String,
    pub modal: Value,
    pub calendar: CalendarCache,
}
