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
};

#[derive(Default)]
pub struct PendingFiles {
    pub paths: Mutex<Vec<String>>,
    pub ready: Mutex<bool>,
}

#[tauri::command]
fn frontend_ready(state: State<PendingFiles>) -> Vec<String> {
    *state.ready.lock().unwrap() = true;
    std::mem::take(&mut *state.paths.lock().unwrap())
}

// File watcher state. We hold one debouncer at a time; opening a new file
// replaces it. The closure inside the debouncer reads `watched_filename`
// and `last_self_write_at` via Arc<Mutex<…>> so we can update them from
// commands without rebuilding the watcher.
#[derive(Default)]
pub struct WatcherState {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    watched_filename: Arc<Mutex<Option<OsString>>>,
    last_self_write_at: Arc<Mutex<Option<Instant>>>,
}

#[tauri::command]
fn watch_file(
    app: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let raw = PathBuf::from(&path);
    let parent = raw
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?
        .to_path_buf();
    // notify reports events with the path as the OS gave it to the watcher
    // (no symlink resolution), so compare by basename rather than by
    // canonical absolute path — agents often write via temp file + rename,
    // and canonicalize() of the temp path doesn't help.
    let filename = raw
        .file_name()
        .ok_or_else(|| "path has no filename".to_string())?
        .to_os_string();

    // Drop the previous watcher (this also stops its background thread)
    // before installing the new one.
    {
        let mut slot = state.debouncer.lock().unwrap();
        *slot = None;
    }

    *state.watched_filename.lock().unwrap() = Some(filename.clone());

    let watched = state.watched_filename.clone();
    let self_write = state.last_self_write_at.clone();
    let app_for_closure = app.clone();
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

            // Suppress events that landed within 750ms of our own write.
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
                let _ = app_for_closure.emit("file-changed", emit_payload.clone());
            }
        },
    )
    .map_err(|e| format!("watcher init failed: {e}"))?;

    debouncer
        .watcher()
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch failed: {e}"))?;

    *state.debouncer.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[tauri::command]
fn unwatch_file(state: State<'_, WatcherState>) {
    *state.debouncer.lock().unwrap() = None;
    *state.watched_filename.lock().unwrap() = None;
}

#[tauri::command]
fn mark_self_write(state: State<'_, WatcherState>) {
    *state.last_self_write_at.lock().unwrap() = Some(Instant::now());
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
    // Collect any file paths passed as launch args (fallback for some launch paths)
    let launch_args: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| std::path::Path::new(a).exists())
        .collect();

    let pending = PendingFiles {
        paths: Mutex::new(launch_args),
        ready: Mutex::new(false),
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(pending)
        .manage(WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            watch_file,
            unwatch_file,
            mark_self_write
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = build_menu(&handle)?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                let _ = app.emit("menu", event.id().0.as_str());
            });

            // Size the main window to full screen height, docked to the left edge.
            // macOS menu bar sits at y=0..~25, so start below it.
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let logical_h = (size.height as f64) / scale;
                    const MENU_BAR: f64 = 28.0;
                    let _ = window.set_position(LogicalPosition::new(0.0, MENU_BAR));
                    let _ = window.set_size(LogicalSize::new(800.0, logical_h - MENU_BAR));
                }

            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building iso.md");

    app.run(|handle, event| {
        if let RunEvent::Opened { urls } = event {
            let state: State<PendingFiles> = handle.state();
            let is_ready = *state.ready.lock().unwrap();
            for url in urls {
                if let Some(path) = url.to_file_path().ok().and_then(|p| p.to_str().map(String::from)) {
                    if is_ready {
                        let _ = handle.emit("file-opened", path);
                    } else {
                        state.paths.lock().unwrap().push(path);
                    }
                }
            }
        }
    });
}
