import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { open as openDialog, save as saveDialog, ask } from "@tauri-apps/plugin-dialog";
import { createEditor, type EditorHandle } from "./editor";

interface AppState {
  path: string | null;
  dirty: boolean;
  editor: EditorHandle;
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

async function updateTitle(state: AppState) {
  const name = state.path ? basename(state.path) : "Untitled";
  const dot = state.dirty ? "● " : "";
  await getCurrentWindow().setTitle(`${dot}${name} — ai.md`);
}

async function openFile(state: AppState, path: string) {
  try {
    const content = await readTextFile(path);
    await state.editor.setMarkdown(content);
    state.path = path;
    state.dirty = false;
    await updateTitle(state);
  } catch (err) {
    console.error("Failed to open file:", err);
    await ask(`Could not open file:\n${err}`, { title: "ai.md", kind: "error" });
  }
}

async function openFileDialog(state: AppState) {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] }],
  });
  if (typeof selected === "string") await openFile(state, selected);
}

async function saveAs(state: AppState): Promise<boolean> {
  const path = await saveDialog({
    defaultPath: state.path ?? "Untitled.md",
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) return false;
  await writeTextFile(path, state.editor.getMarkdown());
  state.path = path;
  state.dirty = false;
  await updateTitle(state);
  return true;
}

async function save(state: AppState): Promise<boolean> {
  if (!state.path) return saveAs(state);
  await writeTextFile(state.path, state.editor.getMarkdown());
  state.dirty = false;
  await updateTitle(state);
  return true;
}

async function newFile(state: AppState) {
  if (state.dirty) {
    const keep = await ask("You have unsaved changes. Discard?", {
      title: "ai.md",
      kind: "warning",
    });
    if (!keep) return;
  }
  await state.editor.setMarkdown("");
  state.path = null;
  state.dirty = false;
  await updateTitle(state);
}

function toggleDarkMode() {
  const html = document.documentElement;
  const hasLight = html.classList.contains("light");
  const hasDark = html.classList.contains("dark");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  html.classList.remove("light", "dark");
  if (hasLight) {
    html.classList.add("dark");
  } else if (hasDark) {
    html.classList.add("light");
  } else {
    html.classList.add(prefersDark ? "light" : "dark");
  }
}

async function exportPdf() {
  // Use the Tauri command so the native macOS print sheet opens reliably
  // (window.print() is a no-op in WKWebView without this).
  try {
    await invoke("export_pdf");
  } catch (err) {
    console.error("export_pdf failed:", err);
    // Fallback: in-webview print (may or may not work)
    window.print();
  }
}

// Zoom: CSS `zoom` on body scales fonts and layout together (WebKit-supported).
const ZOOM_STEPS = [0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6, 1.8, 2.0];
let zoomIndex = ZOOM_STEPS.indexOf(1.0);

function applyZoom() {
  (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom =
    String(ZOOM_STEPS[zoomIndex]);
}
function zoomIn() {
  if (zoomIndex < ZOOM_STEPS.length - 1) { zoomIndex++; applyZoom(); }
}
function zoomOut() {
  if (zoomIndex > 0) { zoomIndex--; applyZoom(); }
}
function zoomReset() {
  zoomIndex = ZOOM_STEPS.indexOf(1.0);
  applyZoom();
}

function toggleFont() {
  document.documentElement.classList.toggle("font-system");
}

async function init() {
  const root = document.getElementById("editor")!;
  const editor = await createEditor(root);

  // Wire up toolbar buttons
  document.getElementById("font-toggle")?.addEventListener("click", toggleFont);
  document.getElementById("export-btn")?.addEventListener("click", exportPdf);

  const state: AppState = { path: null, dirty: false, editor };
  editor.onChange(async () => {
    if (!state.dirty) {
      state.dirty = true;
      await updateTitle(state);
    }
  });
  await updateTitle(state);

  // Listen for menu events from Rust backend
  await listen<string | null>("menu", async (ev) => {
    switch (ev.payload) {
      case "new": await newFile(state); break;
      case "open": await openFileDialog(state); break;
      case "save": await save(state); break;
      case "save-as": await saveAs(state); break;
      case "export-pdf": await exportPdf(); break;
      case "toggle-dark": toggleDarkMode(); break;
      case "zoom-in": zoomIn(); break;
      case "zoom-out": zoomOut(); break;
      case "zoom-reset": zoomReset(); break;
    }
  });

  // File opened via Finder double-click or "open with" — listen for subsequent events
  await listen<string>("file-opened", async (ev) => {
    await openFile(state, ev.payload);
  });

  // Drain any file paths that arrived before the listener was attached
  // (e.g. cold launch from a double-click in Finder)
  try {
    const pending = await invoke<string[]>("frontend_ready");
    if (pending.length > 0) {
      await openFile(state, pending[0]);
    }
  } catch (err) {
    console.error("frontend_ready failed:", err);
  }

  // Confirm close if dirty
  const win = getCurrentWindow();
  await win.onCloseRequested(async (event) => {
    if (state.dirty) {
      const discard = await ask("You have unsaved changes. Close without saving?", {
        title: "ai.md",
        kind: "warning",
      });
      if (!discard) event.preventDefault();
    }
  });

  // Frontend-side keyboard fallbacks (menu accelerators already handle these,
  // but this catches cases where the menu isn't focused)
  window.addEventListener("keydown", (e) => {
    if (!e.metaKey) return;
    if (e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault(); toggleDarkMode(); return;
    }
    // Cmd+= / Cmd++  (zoom in) — "=" key, with or without shift
    if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomIn(); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomOut(); return; }
    if (e.key === "0") { e.preventDefault(); zoomReset(); return; }
  });
}

init().catch((e) => {
  console.error(e);
  document.body.textContent = `Failed to initialize editor: ${e}`;
});
