//! Files handed to the app from outside: dropped on the window, or passed on the command
//! line by the desktop's "Open with".
//!
//! The web side never names a path. Native code decides which files were really offered
//! and gives each an id, and only those ids can be read, once each. A page shown in the
//! app therefore cannot use this to read anything else on the disk.

use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;
use tauri::{ipc::Response, AppHandle, DragDropEvent, Emitter, Manager, State, WindowEvent};

const SUPPORTED_EXTENSIONS: &[&str] = &["pdf", "epub", "md", "markdown", "txt", "text", "tir"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Drop,
    Open,
}

#[derive(Clone, Debug, Serialize)]
pub struct OfferedFile {
    id: u64,
    name: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Offer {
    source: Source,
    files: Vec<OfferedFile>,
    skipped: Vec<String>,
}

#[derive(Clone, Serialize)]
struct DragState {
    active: bool,
    supported: usize,
}

#[derive(Default)]
struct Inbox {
    next_id: u64,
    paths: HashMap<u64, PathBuf>,
    offers: Vec<Offer>,
}

impl Inbox {
    /// Sort paths into readable files and skipped names. Returns false if there were none.
    fn add(&mut self, source: Source, paths: Vec<PathBuf>) -> bool {
        let mut files = Vec::new();
        let mut skipped = Vec::new();
        for path in paths {
            let name = display_name(&path);
            if is_supported(&path) && path.is_file() {
                self.next_id += 1;
                self.paths.insert(self.next_id, path);
                files.push(OfferedFile { id: self.next_id, name });
            } else {
                skipped.push(name);
            }
        }
        if files.is_empty() && skipped.is_empty() {
            return false;
        }
        self.offers.push(Offer { source, files, skipped });
        true
    }
}

/// What has been offered and not yet collected by the web side.
#[derive(Default)]
pub struct FileInbox(Mutex<Inbox>);

fn display_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| SUPPORTED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// The files named on a command line. `args` excludes the program name.
fn paths_from_args(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter_map(|arg| {
            let text = arg.to_string_lossy();
            if text.starts_with('-') {
                return None;
            }
            if text.starts_with("file://") {
                return url::Url::parse(&text).ok()?.to_file_path().ok();
            }
            Some(cwd.join(&arg))
        })
        .collect()
}

/// `args` with relative file names made absolute, or `None` if none needed it.
#[cfg(any(target_os = "linux", test))]
fn absolute_args(args: Vec<OsString>, base: &Path) -> Option<Vec<OsString>> {
    let mut changed = false;
    let result = args
        .into_iter()
        .map(|arg| {
            let text = arg.to_string_lossy();
            let keep = text.starts_with('-')
                || text.starts_with("file://")
                || Path::new(&arg).is_absolute();
            if keep {
                return arg;
            }
            changed = true;
            base.join(&arg).into_os_string()
        })
        .collect();
    changed.then_some(result)
}

/// An AppImage must run from inside its own mount, and its launcher moves there before
/// this process starts, so a relative file name would be looked up in the wrong folder.
/// The AppImage runtime keeps the original folder in `OWD`. Restarting with absolute
/// names covers both a first launch and one that hands its files to a running window.
#[cfg(target_os = "linux")]
pub fn restart_appimage_with_absolute_args() {
    use std::os::unix::process::CommandExt;

    let (Some(owd), Some(appdir)) = (std::env::var_os("OWD"), std::env::var_os("APPDIR")) else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if !exe.starts_with(&appdir) {
        return;
    }
    if let Some(args) = absolute_args(std::env::args_os().skip(1).collect(), Path::new(&owd)) {
        // Only returns on failure, and then the app simply starts with the original names.
        let _ = std::process::Command::new(exe).args(args).exec();
    }
}

fn offer(app: &AppHandle, source: Source, paths: Vec<PathBuf>) {
    let added = app.state::<FileInbox>().0.lock().unwrap().add(source, paths);
    if added {
        let _ = app.emit("files-offered", ());
    }
}

/// Offer the files this process was started with.
pub fn offer_startup_args(app: &AppHandle) {
    let cwd = std::env::current_dir().unwrap_or_default();
    offer(app, Source::Open, paths_from_args(std::env::args_os().skip(1), &cwd));
}

/// A second launch ("Open with" while the app is running): bring the window forward and
/// take its files here.
pub fn offer_from_second_launch(app: &AppHandle, argv: Vec<String>, cwd: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let args = argv.into_iter().skip(1).map(OsString::from);
    offer(app, Source::Open, paths_from_args(args, Path::new(&cwd)));
}

/// Follow files being dragged over the window.
pub fn on_window_event(app: &AppHandle, event: &WindowEvent) {
    let WindowEvent::DragDrop(drag) = event else {
        return;
    };
    let state = match drag {
        DragDropEvent::Enter { paths, .. } => DragState {
            active: true,
            supported: paths.iter().filter(|path| is_supported(path)).count(),
        },
        DragDropEvent::Drop { paths, .. } => {
            offer(app, Source::Drop, paths.clone());
            DragState { active: false, supported: 0 }
        }
        DragDropEvent::Leave => DragState { active: false, supported: 0 },
        _ => return,
    };
    let _ = app.emit("files-drag", state);
}

/// Collect everything offered so far, including what arrived before the page was ready.
#[tauri::command]
pub fn files_take(inbox: State<'_, FileInbox>) -> Vec<Offer> {
    std::mem::take(&mut inbox.0.lock().unwrap().offers)
}

/// The contents of one offered file. Each id works once.
#[tauri::command]
pub async fn file_read(inbox: State<'_, FileInbox>, id: u64) -> Result<Response, String> {
    let path = inbox
        .0
        .lock()
        .unwrap()
        .paths
        .remove(&id)
        .ok_or("This file is no longer available.")?;
    let bytes = tokio::fs::read(&path).await.map_err(|err| err.to_string())?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_become_paths_relative_to_the_launch_folder() {
        let args = ["--flag", "a b.pdf", "/abs/c.md", "file:///abs/d%20e.txt"].map(OsString::from);
        assert_eq!(
            paths_from_args(args, Path::new("/home/me")),
            [
                PathBuf::from("/home/me/a b.pdf"),
                PathBuf::from("/abs/c.md"),
                PathBuf::from("/abs/d e.txt"),
            ]
        );
    }

    #[test]
    fn only_relative_file_names_are_rewritten() {
        let base = Path::new("/home/me");
        let args = ["--flag", "a.pdf", "/abs/b.md", "file:///abs/c.txt"].map(OsString::from);
        assert_eq!(
            absolute_args(args.to_vec(), base).unwrap(),
            ["--flag", "/home/me/a.pdf", "/abs/b.md", "file:///abs/c.txt"].map(OsString::from)
        );
        let settled = ["--flag", "/abs/b.md"].map(OsString::from);
        assert_eq!(absolute_args(settled.to_vec(), base), None);
    }

    #[test]
    fn only_existing_supported_files_get_an_id() {
        let dir = std::env::temp_dir().join(format!("tir-files-{}", std::process::id()));
        let book = dir.join("Book.PDF");
        let picture = dir.join("photo.png");
        let folder = dir.join("folder.md");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(&book, b"x").unwrap();
        std::fs::write(&picture, b"x").unwrap();

        let mut inbox = Inbox::default();
        let missing = dir.join("missing.txt");
        assert!(inbox.add(Source::Drop, vec![book.clone(), picture, folder, missing]));
        let offer = &inbox.offers[0];
        assert_eq!(offer.files.len(), 1);
        assert_eq!(offer.files[0].name, "Book.PDF");
        assert_eq!(offer.skipped, ["photo.png", "folder.md", "missing.txt"]);
        assert_eq!(inbox.paths[&offer.files[0].id], book);

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_empty_launch_offers_nothing() {
        let mut inbox = Inbox::default();
        assert!(!inbox.add(Source::Open, Vec::new()));
        assert!(inbox.offers.is_empty());
    }
}
