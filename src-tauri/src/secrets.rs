//! OS keychain-backed secrets (keyring), plus the tauri commands the frontend
//! `src/lib/secrets.ts` invokes.
//!
//! The frontend dual-writes to the OS keychain AND localStorage
//! (`nolock.apiKey.<backend>`); these commands make the keychain half real. The
//! plain functions here are also used by the headless CLI and the e2e harness so
//! they can read the same OpenRouter key the GUI stores — no secrets are ever
//! written to `.routers/switchyard.json` or the repo.

/// Keyring service name — must match `SERVICE` in `src/lib/secrets.ts`.
pub const KEYCHAIN_SERVICE: &str = "com.nolock.app";

/// Read a secret from the OS keychain. Returns `Ok(None)` when no entry exists.
pub fn read_keychain(service: &str, key: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(service, key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("failed to read secret from keychain: {}", e)),
    }
}

/// Store a secret in the OS keychain (overwrites any existing value).
pub fn store_keychain(service: &str, key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(service, key).map_err(|e| e.to_string())?;
    entry
        .set_password(value)
        .map_err(|e| format!("failed to store secret in keychain: {}", e))
}

/// Delete a secret from the OS keychain. Missing entries are a no-op.
pub fn delete_keychain(service: &str, key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(service, key).map_err(|e| e.to_string())?;
    match entry.delete_password() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to delete secret from keychain: {}", e)),
    }
}

/// Read a provider API key from opencode's auth store
/// (`~/.local/share/opencode/auth.json`), which nolock shares with opencode.
/// The file maps provider names (e.g. `openrouter`) to `{ "type": "api", "key": ... }`.
/// Returns `Ok(None)` when the file or provider entry is absent.
pub fn read_opencode_auth_key(provider: &str) -> Result<Option<String>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let path = std::path::Path::new(&home).join(".local/share/opencode/auth.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    let v: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("failed to parse opencode auth.json: {}", e))?;
    Ok(v.get(provider)
        .and_then(|p| p.get("key"))
        .and_then(|k| k.as_str())
        .map(str::to_string))
}

#[tauri::command]
pub fn store_secret(service: String, key: String, value: String) -> Result<(), String> {
    store_keychain(&service, &key, &value)
}

#[tauri::command]
pub fn get_secret(service: String, key: String) -> Result<Option<String>, String> {
    read_keychain(&service, &key)
}

#[tauri::command]
pub fn delete_secret(service: String, key: String) -> Result<(), String> {
    delete_keychain(&service, &key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_missing_secret_returns_none_or_keychain_unavailable() {
        // On a host with a keyring backend, a missing entry must come back as
        // None; in headless CI the backend is absent and we accept an error.
        match read_keychain("com.nolock.test", "definitely-missing-key") {
            Ok(None) => {}
            Ok(Some(_)) => panic!("missing key should not have a value"),
            Err(_) => {} // no keyring backend available (headless) — acceptable
        }
    }
}
