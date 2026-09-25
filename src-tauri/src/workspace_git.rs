//! Read-only workspace Git state; independent of session timestamps.
use serde::Serialize;
use std::{path::{Path, Component}, process::{Command, Stdio}, io::Read};
const LIMIT: u64 = 2 * 1024 * 1024;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus { path: String, old_path: Option<String>, staged: String, unstaged: String, untracked: bool, conflict: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { repository: String, branch: String, files: Vec<FileStatus> }
#[derive(Serialize)]
pub struct Diff { diff: String, truncated: bool }
fn git(top: &Path, args: &[&str], allow_difference: bool) -> Result<Diff, String> {
    let mut child = Command::new("git").current_dir(top).env("GIT_OPTIONAL_LOCKS", "0")
        .args(["--literal-pathspecs", "-c", "core.quotePath=false", "-c", "color.ui=false"])
        .args(args).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "Unable to start Git.")?;
    let mut data = Vec::new();
    let result = child.stdout.take().unwrap().take(LIMIT + 1).read_to_end(&mut data);
    let truncated = data.len() as u64 > LIMIT;
    if truncated || result.is_err() { let _ = child.kill(); }
    let status = child.wait().map_err(|_| "Unable to read Git result.")?;
    result.map_err(|_| "Unable to read Git output.")?;
    if !truncated && !status.success() && !(allow_difference && status.code() == Some(1)) { return Err("Git could not read this repository or file. Refresh and try again.".into()); }
    data.truncate(LIMIT as usize);
    Ok(Diff { diff: String::from_utf8_lossy(&data).into_owned(), truncated })
}
fn parse(output: &str) -> Vec<FileStatus> {
    let mut parts = output.split('\0').filter(|s| !s.is_empty());
    let mut files = Vec::new();
    while let Some(entry) = parts.next() {
        if entry.len() < 4 || !entry.is_char_boundary(3) { continue; }
        let xy = &entry.as_bytes()[..2];
        let old_path = if xy.contains(&b'R') || xy.contains(&b'C') { parts.next().map(str::to_owned) } else { None };
        files.push(FileStatus { path: entry[3..].to_owned(), old_path,
            staged: (xy[0] as char).to_string(), unstaged: (xy[1] as char).to_string(),
            untracked: xy == b"??", conflict: xy.contains(&b'U') || xy == b"AA" || xy == b"DD" });
    }
    files.sort_by(|a,b| a.path.cmp(&b.path)); files
}
#[tauri::command]
pub fn git_workspace_status(root_path: String) -> Result<Status, String> {
    let top = super::git_toplevel(&root_path).map_err(|_| "This folder is not inside a Git working tree.".to_string())?;
    let result = git(&top, &["status", "--porcelain=v1", "-z", "--untracked-files=all"], false)?;
    if result.truncated { return Err("Repository has too many changes to display (2 MiB status limit).".into()); }
    let branch = git(&top, &["symbolic-ref", "--short", "HEAD"], false).or_else(|_| git(&top, &["rev-parse", "--short", "HEAD"], false))?.diff.trim().to_owned();
    Ok(Status { repository: top.to_string_lossy().into_owned(), branch, files: parse(&result.diff) })
}
#[tauri::command]
pub fn git_workspace_diff(root_path: String, path: String, area: String) -> Result<Diff, String> {
    if path.is_empty() || Path::new(&path).components().any(|p| !matches!(p, Component::Normal(_))) { return Err("Invalid repository-relative file path.".into()); }
    let status = git_workspace_status(root_path)?;
    let file = status.files.iter().find(|f| f.path == path).ok_or("File is no longer changed. Refresh the panel.")?;
    let top = Path::new(&status.repository);
    // Diff is for the human UI only; never a model tool or chat attachment.
    // Avoid reading the target of an untracked symlink or a special device.
    if file.untracked {
        let metadata = std::fs::symlink_metadata(top.join(&path)).map_err(|_| "File is no longer available.")?;
        if !metadata.file_type().is_file() { return Ok(Diff { diff: "Untracked symbolic link or special file; content preview unavailable.".into(), truncated: false }); }
        return git(top, &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-index", "--", "/dev/null", &path], true);
    }
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"];
    match area.as_str() { "staged" => args.push("--cached"), "unstaged" => {}, _ => return Err("Invalid diff area.".into()) }
    args.push("--");
    if let Some(old) = &file.old_path { args.push(old); }
    args.push(&path);
    git(top, &args, false)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn parses_renames_conflicts_and_unusual_paths() {
        let files = parse("RM new name\0old name\0?? :(glob)*\0UU conflict\0 M line\nbreak\0");
        assert_eq!(files.len(),4);
        assert!(files.iter().any(|f| f.old_path.as_deref()==Some("old name") && f.staged=="R" && f.unstaged=="M"));
        assert!(files.iter().any(|f| f.conflict));
        assert!(files.iter().any(|f| f.path=="line\nbreak"));
    }
    #[test] fn detects_renames_deletions_and_binary_diffs() {
        let root = std::env::temp_dir().join(format!("nolock-workspace-git-rename-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init"], false).unwrap();
        std::fs::write(root.join("old.txt"), "original\n").unwrap();
        std::fs::write(root.join("removed.txt"), "remove\n").unwrap();
        std::fs::write(root.join("binary"), [0,1,2]).unwrap();
        git(&root, &["add", "."], false).unwrap();
        git(&root, &["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"], false).unwrap();
        git(&root, &["mv", "old.txt", "new.txt"], false).unwrap();
        std::fs::remove_file(root.join("removed.txt")).unwrap();
        std::fs::write(root.join("binary"), [0,3,4]).unwrap();
        std::fs::write(root.join(":(glob)*"), "literal\n").unwrap();
        let r = root.to_string_lossy().to_string();
        let status = git_workspace_status(r.clone()).unwrap();
        assert!(status.files.iter().any(|f| f.path=="new.txt" && f.old_path.as_deref()==Some("old.txt")));
        assert!(status.files.iter().any(|f| f.path=="removed.txt" && f.unstaged=="D"));
        assert!(git_workspace_diff(r.clone(),"new.txt".into(),"staged".into()).unwrap().diff.contains("rename from old.txt"));
        assert!(git_workspace_diff(r.clone(),"binary".into(),"unstaged".into()).unwrap().diff.contains("Binary files"));
        assert!(git_workspace_diff(r,":(glob)*".into(),"unstaged".into()).unwrap().diff.contains("+literal"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn workspace_includes_index_worktree_and_untracked_without_a_commit() {
        let root = std::env::temp_dir().join(format!("nolock-workspace-git-{}",super::super::now_secs()));
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init"], false).unwrap();
        std::fs::write(root.join("file.txt"), "staged\n").unwrap();
        git(&root, &["add", "file.txt"], false).unwrap();
        std::fs::write(root.join("file.txt"), "working\n").unwrap();
        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored\n").unwrap();
        std::fs::write(root.join("ignored"), "ignored\n").unwrap();
        let r = root.to_string_lossy().to_string();
        let status = git_workspace_status(r.clone()).unwrap();
        assert!(status.files.iter().any(|f| f.path=="file.txt" && f.staged=="A" && f.unstaged=="M"));
        assert!(!status.files.iter().any(|f| f.path=="ignored"));
        assert!(git_workspace_diff(r.clone(),"file.txt".into(),"staged".into()).unwrap().diff.contains("+staged"));
        assert!(git_workspace_diff(r.clone(),"file.txt".into(),"unstaged".into()).unwrap().diff.contains("+working"));
        assert!(git_workspace_diff(r.clone(),"new.txt".into(),"unstaged".into()).unwrap().diff.contains("+new"));
        assert!(git_workspace_diff(r,"../escape".into(),"unstaged".into()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
