//! Session-scoped registry of secret values the backend has legitimately
//! touched (keychain reads, vault lookups, CLI exports), and the redaction
//! applied at every model boundary: chat payloads, tool results and terminal
//! transcripts. Values never leave this process through the registry — it only
//! answers one question: "does this text contain a secret nolock handled?"

use std::collections::HashSet;
use std::sync::{OnceLock, RwLock};

/// Replacement token written wherever a registered secret value appears.
pub const PLACEHOLDER: &str = "[nolock-redacted]";

/// Values shorter than this are never registered: the shorter the needle, the
/// likelier it redacts ordinary text by coincidence.
const MIN_LENGTH: usize = 8;
/// Hard cap so a pathological credential source cannot grow scan cost without
/// bound. A real session registers a handful of values.
const MAX_ENTRIES: usize = 4096;

fn registry() -> &'static RwLock<HashSet<String>> {
    static REGISTRY: OnceLock<RwLock<HashSet<String>>> = OnceLock::new();
    REGISTRY.get_or_init(|| RwLock::new(HashSet::new()))
}

/// Remember a secret value so it is redacted from model-bound text.
pub fn register(value: &str) {
    let value = value.trim();
    if value.len() < MIN_LENGTH {
        return;
    }
    if let Ok(mut entries) = registry().write() {
        if entries.len() < MAX_ENTRIES {
            entries.insert(value.to_string());
        }
    }
}

/// Replace every registered secret value in `text` with [`PLACEHOLDER`].
/// Longer values are replaced first so a value that contains another secret
/// cannot be partially preserved by the shorter one's replacement.
pub fn redact(text: &str) -> String {
    let mut values: Vec<String> = match registry().read() {
        Ok(entries) if !entries.is_empty() => entries.iter().cloned().collect(),
        _ => return text.to_string(),
    };
    values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    let mut out = text.to_string();
    for value in &values {
        if out.contains(value.as_str()) {
            out = out.replace(value.as_str(), PLACEHOLDER);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures are intentionally long and unique: the registry is global for
    // the whole test binary, and these values must not collide with other
    // tests' fixtures.
    const CANARY: &str = "nolock-redaction-canary-9f3ab2";
    const OTHER: &str = "nolock-redaction-second-41c7dd";

    #[test]
    fn redacts_registered_value_everywhere() {
        register(CANARY);
        let text = format!("token={CANARY};\ncurl -H 'X: {CANARY}' done");
        let out = redact(&text);
        assert!(!out.contains(CANARY));
        assert_eq!(out.matches(PLACEHOLDER).count(), 2);
        assert!(out.contains("curl -H"));
    }

    #[test]
    fn longer_values_redact_first() {
        let long = format!("{CANARY}-extended-tail");
        register(CANARY);
        register(&long);
        let out = redact(&format!("value={long}!"));
        assert!(!out.contains(CANARY), "shorter needle must not truncate the longer match");
        assert_eq!(out, format!("value={PLACEHOLDER}!"));
    }

    #[test]
    fn multiple_registered_values_redact_independently() {
        register(CANARY);
        register(OTHER);
        let out = redact(&format!("{CANARY} then {OTHER} then plain"));
        assert!(!out.contains(CANARY) && !out.contains(OTHER));
        assert!(out.contains("then plain"));
    }

    #[test]
    fn short_and_blank_values_are_never_registered() {
        register("abc");
        register("       ");
        assert_eq!(redact("abc and blank"), "abc and blank");
    }

    #[test]
    fn text_redacts_to_itself_without_matches() {
        register(CANARY);
        assert_eq!(redact("nothing secret here"), "nothing secret here");
    }
}
