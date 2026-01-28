use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let version_txt = manifest_dir.join("../../agent/version.txt");

    println!("cargo:rerun-if-changed={}", version_txt.display());

    let version = fs::read_to_string(&version_txt)
        .unwrap_or_else(|err| panic!("Failed to read {}: {err}", version_txt.display()))
        .trim()
        .to_string();
    if version.is_empty() {
        panic!("Empty version file: {}", version_txt.display());
    }

    println!("cargo:rustc-env=APP_VERSION={version}");

    // Preserve Tauri's default build steps (Windows resources/manifest, etc.).
    tauri_build::build();
}
