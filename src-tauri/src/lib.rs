use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder, PredefinedMenuItem},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

// ---------------------------------------------------------------------------
// Window registry
//
// iso.md is document-per-window (like TextEdit): every file gets its own
// window. This tracks, per window label:
//   - `pending`: the file a freshly-spawned window should open once its
//     frontend signals ready (cold start + new windows fetch this via the
//     `frontend_ready` command).
//   - `ready`:   labels whose frontend has booted at least once.
//   - `files`:   the document currently shown in each live window. Drives
//     de-duplication (re-opening an already-open file just focuses it).
//   - `dirty`:   unsaved-changes flag per window, so we know whether a
//     window is a pristine/empty target we can reuse instead of spawning.
// The config-defined startup window has label "main"; programmatic windows
// are "win-1", "win-2", …
// ---------------------------------------------------------------------------
#[derive(Default)]
pub struct WindowRegistry {
    inner: Mutex<RegistryInner>,
}

#[derive(Default)]
struct RegistryInner {
    counter: u64,
    pending: HashMap<String, String>,
    ready: HashSet<String>,
    files: HashMap<String, Option<String>>,
    dirty: HashMap<String, bool>,
}

#[tauri::command]
fn frontend_ready(window: WebviewWindow, reg: State<'_, WindowRegistry>) -> Option<String> {
    let label = window.label().to_string();
    let mut inner = reg.inner.lock().unwrap();
    inner.ready.insert(label.clone());
    let pending = inner.pending.remove(&label);
    match &pending {
        Some(p) => {
            inner.files.insert(label, Some(p.clone()));
        }
        None => {
            inner.files.entry(label).or_insert(None);
        }
    }
    pending
}

// The frontend reports its document identity here whenever it changes
// (open / save-as / new / dirty toggle) so de-duplication and pristine-
// window reuse stay accurate.
#[tauri::command]
fn set_window_state(
    window: WebviewWindow,
    reg: State<'_, WindowRegistry>,
    path: Option<String>,
    dirty: bool,
) {
    let label = window.label().to_string();
    let mut inner = reg.inner.lock().unwrap();
    inner.files.insert(label.clone(), path);
    inner.dirty.insert(label, dirty);
}

#[tauri::command]
fn open_files(
    app: AppHandle,
    reg: State<'_, WindowRegistry>,
    window: WebviewWindow,
    paths: Vec<String>,
) {
    let caller = window.label().to_string();
    for (i, path) in paths.into_iter().enumerate() {
        // Only the first file may reuse the calling window (when it's a
        // pristine, empty doc — e.g. the welcome window). Extra files in a
        // multi-select always get their own windows.
        let hint = if i == 0 { Some(caller.clone()) } else { None };
        open_one(&app, reg.inner(), path, hint);
    }
}

#[tauri::command]
fn new_window(app: AppHandle, reg: State<'_, WindowRegistry>) -> Result<(), String> {
    create_window(&app, reg.inner(), None).map(|_| ())
}

fn open_one(app: &AppHandle, reg: &WindowRegistry, path: String, hint: Option<String>) {
    // 1. Already open somewhere → just focus that window.
    let existing = {
        let inner = reg.inner.lock().unwrap();
        inner
            .files
            .iter()
            .find(|(_, v)| v.as_deref() == Some(path.as_str()))
            .map(|(k, _)| k.clone())
    };
    if let Some(label) = existing {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.unminimize();
            let _ = win.set_focus();
            return;
        }
    }

    // 2. Reuse the hinted window if it's ready, untitled and clean
    //    (TextEdit reuses the empty untitled window instead of stacking
    //    a fresh one in front of it).
    if let Some(h) = &hint {
        let reusable = {
            let inner = reg.inner.lock().unwrap();
            inner.ready.contains(h)
                && inner.files.get(h).map_or(true, |o| o.is_none())
                && !inner.dirty.get(h).copied().unwrap_or(false)
        };
        if reusable {
            if app.get_webview_window(h).is_some() {
                {
                    let mut inner = reg.inner.lock().unwrap();
                    inner.files.insert(h.clone(), Some(path.clone()));
                }
                let _ = app.emit_to(h.as_str(), "file-opened", path.clone());
                if let Some(win) = app.get_webview_window(h) {
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
                return;
            }
        }
    }

    // 3. New window.
    let _ = create_window(app, reg, Some(path));
}

fn screen_logical_height(app: &AppHandle) -> Option<f64> {
    let win = app.webview_windows().into_values().next()?;
    let mon = win.current_monitor().ok()??;
    Some((mon.size().height as f64) / mon.scale_factor())
}

fn create_window(
    app: &AppHandle,
    reg: &WindowRegistry,
    file: Option<String>,
) -> Result<String, String> {
    let (label, step) = {
        let mut inner = reg.inner.lock().unwrap();
        inner.counter += 1;
        let label = format!("win-{}", inner.counter);
        if let Some(f) = &file {
            inner.pending.insert(label.clone(), f.clone());
            inner.files.insert(label.clone(), Some(f.clone()));
        } else {
            inner.files.insert(label.clone(), None);
        }
        // Cascade so stacked windows don't perfectly overlap.
        let step = (inner.counter.saturating_sub(1) % 8) as f64 * 28.0;
        (label, step)
    };

    const MENU_BAR: f64 = 28.0;
    let x = step;
    let y = MENU_BAR + step;
    let (width, height) = match screen_logical_height(app) {
        Some(h) => (800.0, (h - y - 8.0).max(360.0)),
        None => (800.0, 900.0),
    };

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, label.as_str(), WebviewUrl::App("index.html".into()))
        .title("iso.md")
        .inner_size(width, height)
        .position(x, y)
        .min_inner_size(400.0, 360.0)
        .resizable(true)
        .decorations(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    let win = builder
        .build()
        .map_err(|e| format!("window build failed: {e}"))?;
    attach_destroy_cleanup(app, &win);
    Ok(label)
}

// Drop a window's registry + watcher entries when it closes so a later
// "open this file" doesn't try to focus a dead window.
fn attach_destroy_cleanup(app: &AppHandle, win: &WebviewWindow) {
    let app = app.clone();
    let label = win.label().to_string();
    win.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Some(reg) = app.try_state::<WindowRegistry>() {
                let mut inner = reg.inner.lock().unwrap();
                inner.pending.remove(&label);
                inner.ready.remove(&label);
                inner.files.remove(&label);
                inner.dirty.remove(&label);
            }
            if let Some(watchers) = app.try_state::<WatcherState>() {
                watchers.by_window.lock().unwrap().remove(&label);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// File watcher (per window)
//
// Each window watches its own open file. The closure compares by basename
// (agents often write via temp file + rename) and suppresses events within
// 750ms of our own write. Events are emitted only to the owning window so
// other windows don't reload someone else's file.
// ---------------------------------------------------------------------------
#[derive(Default)]
pub struct WatcherState {
    by_window: Mutex<HashMap<String, WindowWatcher>>,
}

struct WindowWatcher {
    _debouncer: Debouncer<RecommendedWatcher>,
    last_self_write_at: Arc<Mutex<Option<Instant>>>,
}

#[tauri::command]
fn watch_file(
    app: AppHandle,
    window: WebviewWindow,
    watchers: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let raw = PathBuf::from(&path);
    let parent = raw
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?
        .to_path_buf();
    let filename = raw
        .file_name()
        .ok_or_else(|| "path has no filename".to_string())?
        .to_os_string();

    // Drop this window's previous watcher before installing the new one.
    watchers.by_window.lock().unwrap().remove(&label);

    let watched_filename: Arc<Mutex<Option<OsString>>> = Arc::new(Mutex::new(Some(filename)));
    let last_self_write_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));

    let watched = watched_filename.clone();
    let self_write = last_self_write_at.clone();
    let app_for_closure = app.clone();
    let label_for_closure = label.clone();
    let emit_payload = path.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        move |res: DebounceEventResult| {
            let events = match res {
                Ok(e) => e,
                Err(err) => {
                    eprintln!("file watcher error: {err:?}");
                    return;
                }
            };

            let Some(target) = watched.lock().unwrap().clone() else { return };

            let recent_self_write = self_write
                .lock()
                .unwrap()
                .map(|t| t.elapsed() < Duration::from_millis(750))
                .unwrap_or(false);
            if recent_self_write {
                return;
            }

            let matched = events
                .iter()
                .any(|ev| ev.path.file_name() == Some(target.as_os_str()));
            if matched {
                let _ = app_for_closure.emit_to(
                    label_for_closure.as_str(),
                    "file-changed",
                    emit_payload.clone(),
                );
            }
        },
    )
    .map_err(|e| format!("watcher init failed: {e}"))?;

    debouncer
        .watcher()
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch failed: {e}"))?;

    watchers.by_window.lock().unwrap().insert(
        label,
        WindowWatcher {
            _debouncer: debouncer,
            last_self_write_at,
        },
    );
    Ok(())
}

#[tauri::command]
fn unwatch_file(window: WebviewWindow, watchers: State<'_, WatcherState>) {
    watchers.by_window.lock().unwrap().remove(window.label());
}

#[tauri::command]
fn mark_self_write(window: WebviewWindow, watchers: State<'_, WatcherState>) {
    if let Some(w) = watchers.by_window.lock().unwrap().get(window.label()) {
        *w.last_self_write_at.lock().unwrap() = Some(Instant::now());
    }
}

fn focused_label(app: &AppHandle) -> Option<String> {
    for (label, win) in app.webview_windows() {
        if win.is_focused().unwrap_or(false) {
            return Some(label);
        }
    }
    None
}

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    // App submenu (macOS) — about, services, hide, quit
    let app_menu = SubmenuBuilder::new(app, "iso.md")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // File
    let new_item = MenuItemBuilder::new("New").id("new").accelerator("CmdOrCtrl+N").build(app)?;
    let open_item = MenuItemBuilder::new("Open…").id("open").accelerator("CmdOrCtrl+O").build(app)?;
    let save_item = MenuItemBuilder::new("Save").id("save").accelerator("CmdOrCtrl+S").build(app)?;
    let save_as_item = MenuItemBuilder::new("Save As…").id("save-as").accelerator("CmdOrCtrl+Shift+S").build(app)?;
    let export_pdf_item = MenuItemBuilder::new("Export as PDF…").id("export-pdf").accelerator("CmdOrCtrl+E").build(app)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_item)
        .item(&open_item)
        .separator()
        .item(&save_item)
        .item(&save_as_item)
        .separator()
        .item(&export_pdf_item)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, Some("Close"))?)
        .build()?;

    // Edit — predefined items provide the standard behavior
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // View
    let toggle_dark_item = MenuItemBuilder::new("Toggle Dark Mode")
        .id("toggle-dark")
        .accelerator("CmdOrCtrl+Shift+D")
        .build(app)?;
    let zoom_in_item = MenuItemBuilder::new("Zoom In")
        .id("zoom-in")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out_item = MenuItemBuilder::new("Zoom Out")
        .id("zoom-out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset_item = MenuItemBuilder::new("Actual Size")
        .id("zoom-reset")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_dark_item)
        .separator()
        .item(&zoom_in_item)
        .item(&zoom_out_item)
        .item(&zoom_reset_item)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, Some("Enter Full Screen"))?)
        .build()?;

    // Window
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(WindowRegistry::default())
        .manage(WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            set_window_state,
            open_files,
            new_window,
            watch_file,
            unwatch_file,
            mark_self_write
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = build_menu(&handle)?;
            app.set_menu(menu)?;

            // The macOS menu bar is app-global and acts on the focused
            // window — route the event only there, not to every window.
            app.on_menu_event(|app, event| {
                let id = event.id().0.clone();
                match focused_label(app) {
                    Some(label) => {
                        let _ = app.emit_to(label.as_str(), "menu", id);
                    }
                    None => {
                        let _ = app.emit("menu", id);
                    }
                }
            });

            // Size the config-defined startup window to full screen height,
            // docked to the left edge, just below the macOS menu bar.
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let logical_h = (size.height as f64) / scale;
                    const MENU_BAR: f64 = 28.0;
                    let _ = window.set_position(LogicalPosition::new(0.0, MENU_BAR));
                    let _ = window.set_size(LogicalSize::new(800.0, logical_h - MENU_BAR));
                }
                attach_destroy_cleanup(&handle, &window);
            }

            // Files passed as launch args (some launch paths use argv
            // rather than the Opened event). First file goes to the main
            // window; any extras get their own windows.
            let launch_args: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .filter(|a| std::path::Path::new(a).exists())
                .collect();

            let reg = app.state::<WindowRegistry>();
            {
                let mut inner = reg.inner.lock().unwrap();
                inner.files.entry("main".into()).or_insert(None);
            }
            if let Some((first, rest)) = launch_args.split_first() {
                {
                    let mut inner = reg.inner.lock().unwrap();
                    inner.pending.insert("main".into(), first.clone());
                    inner.files.insert("main".into(), Some(first.clone()));
                }
                for extra in rest {
                    let _ = create_window(&handle, reg.inner(), Some(extra.clone()));
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building iso.md");

    app.run(|handle, event| {
        if let RunEvent::Opened { urls } = event {
            let reg = handle.state::<WindowRegistry>();
            for url in urls {
                let Some(path) = url
                    .to_file_path()
                    .ok()
                    .and_then(|p| p.to_str().map(String::from))
                else {
                    continue;
                };

                let any_ready = !reg.inner.lock().unwrap().ready.is_empty();
                if any_ready {
                    let hint = focused_label(handle);
                    open_one(handle, reg.inner(), path, hint);
                    continue;
                }

                // Cold start: a frontend hasn't booted yet. macOS may
                // deliver the launch file via *both* argv and this event,
                // so skip anything already accounted for, then route the
                // first file into the still-loading main window.
                let mut inner = reg.inner.lock().unwrap();
                let already = inner.files.values().any(|v| v.as_deref() == Some(path.as_str()))
                    || inner.pending.values().any(|p| p == &path);
                if already {
                    continue;
                }
                let main_busy = inner.pending.contains_key("main")
                    || matches!(inner.files.get("main"), Some(Some(_)));
                if !main_busy {
                    inner.pending.insert("main".into(), path.clone());
                    inner.files.insert("main".into(), Some(path));
                    continue;
                }
                drop(inner);
                let _ = create_window(handle, reg.inner(), Some(path));
            }
        }
    });
}
