//! Project MCP registry, shared with coding agents through ordinary config files.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, Server>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Server {
    #[serde(default, rename = "type", skip_serializing_if = "String::is_empty")]
    pub transport: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub disabled: bool,
}
fn project_key(root: &str) -> Result<String, String> {
    let project = Path::new(root).canonicalize().map_err(|_| "Open a project folder first.")?;
    if !project.is_dir() { return Err("Open a project folder first.".into()); }
    Ok(format!("mcp.project.{:x}", Sha256::digest(project.to_string_lossy().as_bytes())))
}
pub fn validate(config: &Config) -> Result<(), String> {
    if config.mcp_servers.len() > 32 || serde_json::to_vec(config).map_err(|_| "Invalid MCP configuration.")?.len() > 48 * 1024 {
        return Err("Use at most 32 servers and 48 KiB of configuration.".into());
    }
    for (name, server) in &config.mcp_servers {
        if name.is_empty() || name.len() > 64 || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
            return Err("Server names must use letters, digits, hyphens or underscores.".into());
        }
        if !server.transport.is_empty() && server.transport != if server.url.is_empty() { "stdio" } else { "http" } {
            return Err("Server type must match its transport: stdio or http.".into());
        }
        if server.command.is_empty() == server.url.is_empty() { return Err("Each server needs exactly one command or HTTP(S) URL.".into()); }
        if server.command.chars().any(char::is_control) || server.args.iter().any(|v| v.contains('\0')) || server.args.len() > 128 {
            return Err("Invalid command or arguments. Enter arguments as a JSON array.".into());
        }
        if !server.url.is_empty() {
            let url = reqwest::Url::parse(&server.url).map_err(|_| "Invalid MCP URL.")?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
                || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
                return Err("Use an HTTP(S) endpoint without URL credentials or fragments.".into());
            }
            if !server.env.is_empty() || !server.args.is_empty() { return Err("Remote servers use headers, not arguments or environment settings.".into()); }
        } else if !server.headers.is_empty() { return Err("Local servers use environment settings, not HTTP headers.".into()); }
        for (key, value) in &server.env {
            if key.is_empty() || !key.bytes().enumerate().all(|(i,c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
                || key.starts_with("NOLOCK_") || value.contains('\0') {
                return Err("Invalid environment variable. NOLOCK_ names are reserved.".into());
            }
        }
        for (key, value) in &server.headers {
            if reqwest::header::HeaderName::from_bytes(key.as_bytes()).is_err() || reqwest::header::HeaderValue::from_str(value).is_err()
                || matches!(key.to_ascii_lowercase().as_str(), "host" | "content-length" | "connection" | "transfer-encoding") {
                return Err("Invalid MCP HTTP header.".into());
            }
        }
    }
    Ok(())
}
pub fn config_path(root: &str) -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("Home directory unavailable.")?;
    Ok(std::path::PathBuf::from(home).join(".config/nolock/mcp").join(format!("{}.json", project_key(root)?)))
}
fn write_config(path: &Path, config: &Config) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Invalid MCP settings path.")?;
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create MCP settings directory.")?;
    let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let tmp = parent.join(format!(".mcp-{}-{id}.tmp", std::process::id()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&tmp).map_err(|_| "Cannot create MCP settings.")?;
        let bytes = serde_json::to_vec_pretty(config).map_err(|_| "Invalid MCP settings.")?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "Cannot write MCP settings.")?;
        std::fs::rename(&tmp, path).map_err(|_| "Cannot replace MCP settings.")
    })();
    if result.is_err() { let _ = std::fs::remove_file(tmp); }
    result.map_err(str::to_string)
}
pub fn load(root: &str) -> Result<Config, String> {
    let path = config_path(root)?;
    if !path.exists() {
        // One-time compatibility with the old MCP store, not a credential broker.
        // Existing vault credentials are never deleted by this migration.
        let old = super::secrets::read_keychain(super::secrets::KEYCHAIN_SERVICE, &project_key(root)?)
            .map_err(|_| "Could not migrate previous MCP settings. Unlock the keychain or save a new configuration.")?;
        let config = match old {
            Some(value) => serde_json::from_str(&value).map_err(|_| "Invalid previous MCP settings.")?,
            None => Config::default(),
        };
        validate(&config)?;
        write_config(&path, &config)?;
        return Ok(config);
    }
    let bytes = std::fs::read(&path).map_err(|_| "Cannot read MCP settings.")?;
    if bytes.len() > 64 * 1024 { return Err("MCP settings exceed the size limit.".into()); }
    let config = serde_json::from_slice(&bytes).map_err(|_| "Invalid saved MCP settings.")?;
    validate(&config)?;
    Ok(config)
}
#[tauri::command]
pub fn list_mcp_servers(root_path: String) -> Result<Config, String> { load(&root_path) }
#[tauri::command]
pub fn save_mcp_servers(root_path: String, config: Config) -> Result<(), String> {
    validate(&config)?;
    write_config(&config_path(&root_path)?, &config)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supports_local_network_and_stdio() {
        for url in ["http://localhost:11434/mcp", "http://127.0.0.1:3000/mcp", "https://example.com:8443/mcp"] {
            let mut config = Config::default();
            config.mcp_servers.insert("local".into(), Server { url: url.into(), ..Default::default() });
            assert!(validate(&config).is_ok());
        }
        let config: Config = serde_json::from_value(serde_json::json!({"mcpServers":{"tools":{"command":"npx","args":["-y","example"],"env":{"TOKEN":"value"}}}})).unwrap();
        assert!(validate(&config).is_ok());
    }
    #[test]
    fn rejects_ambiguous_config() {
        for server in [serde_json::json!({"url":"file:///tmp/x"}), serde_json::json!({"url":"https://example.com","command":"tool"}), serde_json::json!({"url":"https://user:password@example.com"})] {
            let config: Config = serde_json::from_value(serde_json::json!({"mcpServers":{"x":server}})).unwrap();
            assert!(validate(&config).is_err());
        }
    }
    #[test]
    fn file_storage_roundtrips_without_keychain() {
        let path = std::env::temp_dir().join(format!("nolock-mcp-file-{}.json", std::process::id()));
        let config: Config = serde_json::from_value(serde_json::json!({"mcpServers":{"x":{"command":"tool"}}})).unwrap();
        write_config(&path, &config).unwrap();
        let saved: Config = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved.mcp_servers["x"].command, "tool");
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600); }
        std::fs::remove_file(path).unwrap();
    }
}
