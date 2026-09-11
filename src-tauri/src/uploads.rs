use std::io::Write;

pub const MAX_UPLOAD_BYTES: usize = 10_000_000;

pub fn save_upload(directory: &str, name: &str, content: &[u8]) -> Result<String, String> {
    if content.len() > MAX_UPLOAD_BYTES {
        return Err("Files must be 10 MB or smaller".into());
    }
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return Err("Invalid upload filename".into());
    }
    let directory = std::fs::canonicalize(directory).map_err(|e| e.to_string())?;
    if !directory.is_dir() {
        return Err("Upload destination must be a directory".into());
    }
    let path = directory.join(name);
    // Exclusive creation also prevents following an existing destination symlink.
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true)
        .open(&path).map_err(|e| format!("Cannot upload {name}: {e}"))?;
    if let Err(e) = file.write_all(content) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(format!("Cannot upload {name}: {e}"));
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uploads_preserve_bytes_and_enforce_limits_and_names() {
        let dir = std::env::temp_dir().join(format!("nolock-upload-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        let bytes = vec![255; MAX_UPLOAD_BYTES];
        let path = save_upload(root, "binary.dat", &bytes).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(save_upload(root, "binary.dat", b"overwrite").is_err());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), MAX_UPLOAD_BYTES as u64);
        assert!(save_upload(root, "big.dat", &vec![0; MAX_UPLOAD_BYTES + 1]).is_err());
        for name in ["", ".", "..", "../escape", "a/b", "a\\b", "C:escape"] {
            assert!(save_upload(root, name, b"").is_err());
        }
        save_upload(root, "empty", b"").unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
