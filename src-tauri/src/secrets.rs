//! API key storage in the OS keychain (Windows Credential Manager) via `keyring`.
//! The key is never written to settings.json and never crosses IPC except when the
//! user explicitly saves it. The TTS path reads it server-side via `get_api_key`.

use keyring::Entry;

/// Credential "service" name; the provider (e.g. "openai") is the account.
const SERVICE: &str = "minhavoz";

fn entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(|e| format!("keychain unavailable: {e}"))
}

/// Read a saved key. Returns None if missing or the store is unavailable.
pub fn get_api_key(provider: &str) -> Option<String> {
    let k = entry(provider).ok()?.get_password().ok()?;
    if k.trim().is_empty() {
        None
    } else {
        Some(k)
    }
}

/// Save (or, when given an empty string, clear) the key for a provider.
#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let e = entry(&provider)?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return match e.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("could not clear key: {err}")),
        };
    }
    e.set_password(trimmed)
        .map_err(|err| format!("could not save key: {err}"))
}

/// Whether a non-empty key is stored for the provider.
#[tauri::command]
pub fn has_api_key(provider: String) -> bool {
    get_api_key(&provider).is_some()
}

/// Remove the stored key for a provider. A missing key is not an error.
#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("could not delete key: {err}")),
    }
}
