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

pub fn ls_remote_head_sha(repo_slug: &str, branch: &str) -> Result<String, String> {
    let url = format!("https://github.com/{repo_slug}.git");
    let refspec = format!("refs/heads/{branch}");

    let mut cmd = Command::new("git");
    cmd.args(["ls-remote", &url, &refspec]);
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
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let sha = stdout
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if sha.len() < 7 {
        return Err("failed to parse remote sha".to_string());
    }
    Ok(sha)
}

pub fn clone_sparse_data(repo_dir: &Path, repo_slug: &str, branch: &str) -> Result<String, String> {
    if repo_dir.exists() {
        return Err(format!("target exists: {}", repo_dir.display()));
    }
    if let Some(parent) = repo_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let url = format!("https://github.com/{repo_slug}.git");

    // Sparse-checkout `data/` only.
    let mut cmd = Command::new("git");
    cmd.args([
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        branch,
        &url,
    ])
    .arg(repo_dir);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let status = cmd.status().map_err(|e| format!("git clone failed: {e}"))?;
    if !status.success() {
        // Fallback for older git versions: full clone.
        let mut fallback = Command::new("git");
        fallback
            .args(["clone", "--depth", "1", "--branch", branch, &url])
            .arg(repo_dir);
        #[cfg(target_os = "windows")]
        {
            fallback.creation_flags(CREATE_NO_WINDOW);
        }
        let status = fallback
            .status()
            .map_err(|e| format!("git clone failed: {e}"))?;
        if !status.success() {
            return Err("git clone failed".to_string());
        }
    }

    let _ = run_git(&["sparse-checkout", "set", "data"], repo_dir);
    let sha = run_git(&["rev-parse", "HEAD"], repo_dir)?;
    Ok(sha)
}
