use std::path::Path;
use std::process::{Command, Output};

use serde::Serialize;

/* ================================================================== */
/* FILE ENTRIES                                                        */
/* ================================================================== */

#[derive(Debug, Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub created: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct FileMeta {
    pub exists: bool,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub created: Option<u64>,
    pub path: String,
    pub readable: bool,
    pub writable: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProcessEntry {
    pub name: String,
    pub pid: String,
    pub session_name: String,
    pub session_number: String,
    pub memory_kb: String,
}

/* ================================================================== */
/* STORAGE MUTATION HOOK                                               */
/* ================================================================== */

/// Reads a local file from any directory reachable by the OS user.
#[tauri::command]
async fn read_local_file(path: String) -> Result<String, String> {
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => Ok(contents),
        Err(e) => Err(format!(
            "read_local_file failed for '{path}': {}",
            friendly_io_error(&e)
        )),
    }
}

/// Writes `content` to `path`, creating any missing parent directories.
#[tauri::command]
async fn write_local_file(path: String, content: String) -> Result<(), String> {
    let target = Path::new(&path);

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "write_local_file: could not create parent dirs for '{}': {}",
                    parent.display(),
                    friendly_io_error(&e)
                )
            })?;
        }
    }

    tokio::fs::write(target, content).await.map_err(|e| {
        format!(
            "write_local_file failed for '{path}': {}",
            friendly_io_error(&e)
        )
    })
}

/// Lists a directory and returns structured entries for the AI navigator.
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("list_directory: '{path}' is not a directory"));
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    let read = std::fs::read_dir(dir).map_err(|e| {
        format!(
            "list_directory: cannot read '{path}': {}",
            friendly_io_error(&e)
        )
    })?;

    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        let child_path = item.path();
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        entries.push(FileEntry {
            name,
            path: child_path.to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            is_file: meta.is_file(),
            is_symlink: meta.file_type().is_symlink(),
            size: if meta.is_file() { meta.len() } else { 0 },
            modified: meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()),
            created: meta.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Returns metadata about a single path without reading its contents.
#[tauri::command]
fn file_metadata(path: String) -> Result<FileMeta, String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Ok(FileMeta {
            exists: false,
            is_dir: false,
            is_file: false,
            is_symlink: false,
            size: 0,
            modified: None,
            created: None,
            path,
            readable: false,
            writable: false,
        });
    }

    let meta = target.metadata().map_err(|e| {
        format!(
            "file_metadata failed for '{path}': {}",
            friendly_io_error(&e)
        )
    })?;

    Ok(FileMeta {
        exists: true,
        is_dir: meta.is_dir(),
        is_file: meta.is_file(),
        is_symlink: meta.file_type().is_symlink(),
        size: meta.len(),
        modified: meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()),
        created: meta.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()),
        readable: is_readable(target),
        writable: is_writable(target),
        path,
    })
}

/// Deletes a file, or recursively removes a directory tree.
#[tauri::command]
async fn delete_local_file(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("delete_local_file: '{path}' does not exist"));
    }

    if target.is_dir() {
        tokio::fs::remove_dir_all(target).await.map_err(|e| {
            format!(
                "delete_local_file: could not remove directory '{path}': {}",
                friendly_io_error(&e)
            )
        })
    } else {
        tokio::fs::remove_file(target).await.map_err(|e| {
            format!(
                "delete_local_file: could not remove file '{path}': {}",
                friendly_io_error(&e)
            )
        })
    }
}

/// Moves or renames a file/directory, creating the destination parent.
#[tauri::command]
async fn move_local_file(source: String, destination: String) -> Result<(), String> {
    let src = Path::new(&source);
    if !src.exists() {
        return Err(format!("move_local_file: '{source}' does not exist"));
    }

    if let Some(parent) = Path::new(&destination).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "move_local_file: could not create destination dirs for '{}': {}",
                    parent.display(),
                    friendly_io_error(&e)
                )
            })?;
        }
    }

    tokio::fs::rename(src, &destination).await.map_err(|e| {
        format!(
            "move_local_file: could not move '{source}' to '{destination}': {}",
            friendly_io_error(&e)
        )
    })
}

// ── permission probes (Windows: OPEN_EXISTING + desired access bits) ────

fn is_readable(path: &Path) -> bool {
    // Opening with read access is the OS-level proof of readability.
    // Works on Windows too, where directories are openable handles.
    std::fs::File::open(path).is_ok()
}

fn is_writable(path: &Path) -> bool {
    if let Some(parent) = path.parent() {
        let base = if parent.as_os_str().is_empty() { path } else { parent };
        let probe = base.join(format!(".big_g_probe_{}", std::process::id()));
        if std::fs::write(&probe, b"x").is_ok() {
            let _ = std::fs::remove_file(&probe);
            return true;
        }
    }
    #[cfg(windows)]
    {
        let meta = path.metadata();
        meta.map(|m| !m.permissions().readonly()).unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/* ================================================================== */
/* NATIVE COMMAND PIPELINE                                             */
/* ================================================================== */

/// Executes a native process or command-prompt pipeline, capturing stdout
/// and stderr completely. Falls back to `cmd /C` for shell builtins.
#[tauri::command]
fn execute_windows_command(command: String, args: Vec<String>) -> Result<String, String> {
    run_process(&command, &args)
}

/// Opens a path (file, folder, URL, or application) with the default
/// Windows handler.
#[tauri::command]
fn open_in_explorer(path: String) -> Result<String, String> {
    let result = run_process("explorer", &[format!("/select,{path}")]);
    match result {
        Ok(out) => Ok(format!("opened in Explorer: {path}\n{out}")),
        Err(out) => Err(format!("open_in_explorer failed for '{path}': {out}")),
    }
}

/// Enumerates running processes via `tasklist` (CSV) for the AI process manager.
#[tauri::command]
fn list_processes() -> Result<Vec<ProcessEntry>, String> {
    let output = Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output()
        .map_err(|e| format!("tasklist failed to spawn: {e}"))?;

    let text = String::from_utf8_lossy(&output.stdout);
    let mut processes: Vec<ProcessEntry> = Vec::new();

    // tasklist CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
    for line in text.lines() {
        let clean = line.trim_matches(|c| c == '\r' || c == '"');
        let fields: Vec<&str> = clean.split("\",\"").collect();
        if fields.len() >= 5 {
            processes.push(ProcessEntry {
                name: fields[0].trim_matches('"').to_string(),
                pid: fields[1].trim_matches('"').to_string(),
                session_name: fields[2].trim_matches('"').to_string(),
                session_number: fields[3].trim_matches('"').to_string(),
                memory_kb: fields[4].trim_matches('"').to_string(),
            });
        }
    }

    processes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(processes)
}

/// Force-kills a process by image name.
#[tauri::command]
fn kill_process_name(name: String) -> Result<String, String> {
    let out = Command::new("taskkill")
        .args(["/IM", &name, "/F", "/T"])
        .output()
        .map_err(|e| format!("taskkill failed to spawn: {e}"))?;
    finalize_output_debug(&format!("taskkill /IM {name}"), &out)
}

/// Force-kills a process by PID.
#[tauri::command]
fn kill_process_pid(pid: String) -> Result<String, String> {
    let out = Command::new("taskkill")
        .args(["/PID", &pid, "/F", "/T"])
        .output()
        .map_err(|e| format!("taskkill failed to spawn: {e}"))?;
    finalize_output_debug(&format!("taskkill /PID {pid}"), &out)
}

fn finalize_output_debug(label: &str, output: &Output) -> Result<String, String> {
    finalize_output(label, Output {
        status: output.status,
        stdout: output.stdout.clone(),
        stderr: output.stderr.clone(),
    })
}

fn run_process(command: &str, args: &[String]) -> Result<String, String> {
    let direct = Command::new(command).args(args).output();

    match direct {
        Ok(output) => finalize_output(command, output),
        Err(spawn_err) => {
            #[cfg(target_os = "windows")]
            {
                let mut shell = Command::new("cmd");
                shell.arg("/C").arg(command);
                shell.args(args);

                shell
                    .output()
                    .map(|output| finalize_output(command, output))
                    .map_err(|fallback_err| {
                        format!(
                            "execute_windows_command: direct spawn of '{command}' failed ({spawn_err}) and cmd /C fallback also failed ({fallback_err})"
                        )
                    })?
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(format!(
                    "execute_windows_command: failed to spawn '{command}': {spawn_err}"
                ))
            }
        }
    }
}

fn finalize_output(command: &str, output: Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let mut combined = String::new();
    if !stdout.is_empty() {
        combined.push_str(stdout.trim_end());
    }
    if !stdout.is_empty() && !stderr.is_empty() {
        combined.push('\n');
    }
    if !stderr.is_empty() {
        combined.push_str(stderr.trim_end());
    }

    if output.status.success() {
        Ok(combined)
    } else {
        Err(format!(
            "{command} exited with {}\n{}",
            output.status,
            if combined.is_empty() {
                "(no output captured)".to_string()
            } else {
                combined
            }
        ))
    }
}

/// Normalizes Windows lock/share violations and access errors.
fn friendly_io_error(e: &std::io::Error) -> String {
    #[cfg(windows)]
    {
        let raw = e.raw_os_error().unwrap_or(0);
        match raw {
            32 => format!("{e} (ERROR_SHARING_VIOLATION: folder/file is locked by another process)"),
            33 => format!("{e} (ERROR_LOCK_VIOLATION: a mandatory lock is held on this resource)"),
            5 => format!("{e} (ERROR_ACCESS_DENIED: permission denied)"),
            _ => e.to_string(),
        }
    }
    #[cfg(not(windows))]
    {
        e.to_string()
    }
}

/* ================================================================== */
/* ENTRYPOINT                                                          */
/* ================================================================== */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            read_local_file,
            write_local_file,
            list_directory,
            file_metadata,
            delete_local_file,
            move_local_file,
            execute_windows_command,
            open_in_explorer,
            list_processes,
            kill_process_name,
            kill_process_pid
        ])
        .run(tauri::generate_context!())
        .expect("error while running Big G tauri application");
}