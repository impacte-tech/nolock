//! Provider setup checks only. Never read passwords, tokens, vault items or sessions.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAvailability {
    pub one_password: bool,
    pub bitwarden: bool,
    pub bitwarden_secrets: bool,
}

fn executable_exists(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| std::env::split_paths(&paths).any(|directory| {
        if !directory.is_absolute() { return false; }
        let path = directory.join(if cfg!(windows) { format!("{name}.exe") } else { name.into() });
        let Ok(meta) = path.metadata() else { return false; };
        if !meta.is_file() { return false; }
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; meta.permissions().mode() & 0o111 != 0 }
        #[cfg(not(unix))] { true }
    }))
}

#[tauri::command]
pub fn credential_provider_availability() -> ProviderAvailability {
    ProviderAvailability { one_password: executable_exists("op"), bitwarden: executable_exists("bw"), bitwarden_secrets: executable_exists("bws") }
}
