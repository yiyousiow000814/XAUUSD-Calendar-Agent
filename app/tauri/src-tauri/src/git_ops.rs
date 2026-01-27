use std::path::Path;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn run_git(args: &[&str], cwd: &Path) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(stderr.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn ensure_repo(repo_dir: &Path, repo_slug: &str, branch: &str) -> Result<(), String> {
    if repo_dir.join(".git").exists() {
        return Ok(());
    }
    if let Some(parent) = repo_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let url = format!("https://github.com/{repo_slug}.git");
    let mut cmd = Command::new("git");
    cmd.args(["clone", "--depth", "1", "--branch", branch, &url])
        .arg(repo_dir);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let status = cmd.status().map_err(|e| format!("git clone failed: {e}"))?;
    if !status.success() {
        return Err("git clone failed".to_string());
    }
    Ok(())
}

pub fn pull_ff_only(repo_dir: &Path) -> Result<String, String> {
    let _ = run_git(&["fetch", "origin"], repo_dir);
    let _ = run_git(&["pull", "--ff-only"], repo_dir)?;
    let sha = run_git(&["rev-parse", "HEAD"], repo_dir)?;
    Ok(sha)
}
