import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readTextFile, writeTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { open as openDialog, save as saveDialog, ask } from "@tauri-apps/plugin-dialog";
import html2pdf from "html2pdf.js";
import { createEditor, type EditorHandle } from "./editor";
import { installAutoSizer, sizeAllTables } from "./table-sizer";

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

  // Also update the in-window titlebar element (the native title is
  // hidden via tauri.conf's hiddenTitle: true).
  const el = document.getElementById("filename-display");
  if (el) {
    el.textContent = name;
    el.classList.toggle("dirty", state.dirty);
  }
}

// YAML frontmatter round-trip.
//
// A lot of the markdown files we edit (agent skills, Hermes configs,
// static-site posts) start with
//   ---
//   name: foo
//   tags: [...]
//   ---
// Milkdown's commonmark parser renders the opening `---` as a <hr>
// and then collapses the YAML body into a paragraph (single newlines
// become spaces), which is unreadable. We preprocess on load to wrap
// that block in a ```yaml fenced code block (preserves formatting +
// renders as monospace), and reverse the transform on save so the
// file on disk keeps its real frontmatter for other tools.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FENCED_YAML_AT_TOP_RE = /^```ya?ml\r?\n([\s\S]*?)\r?\n```\r?\n?/;

function markdownToEditorFormat(md: string): string {
  const m = md.match(FRONTMATTER_RE);
  if (!m) return md;
  const yaml = m[1];
  const rest = md.slice(m[0].length);
  return "```yaml\n" + yaml + "\n```\n\n" + rest.replace(/^\s+/, "");
}

function editorFormatToMarkdown(md: string): string {
  const m = md.match(FENCED_YAML_AT_TOP_RE);
  if (!m) return md;
  const yaml = m[1];
  const rest = md.slice(m[0].length);
  return "---\n" + yaml + "\n---\n\n" + rest.replace(/^\s+/, "");
}

async function openFile(state: AppState, path: string) {
  try {
    const content = await readTextFile(path);
    await state.editor.setMarkdown(markdownToEditorFormat(content));
    state.path = path;
    state.dirty = false;
    await updateTitle(state);
    // Size columns after the file's tables render. We pass getCtx so
    // the sizer can write widths into ProseMirror's state via the
    // colwidth cell attribute — prosemirror-tables' TableView renders
    // those widths reliably on every update.
    const getCtx = () => state.editor.getCtx();
    requestAnimationFrame(() => {
      sizeAllTables(getCtx);
      setTimeout(() => sizeAllTables(getCtx), 120);
      setTimeout(() => sizeAllTables(getCtx), 400);
    });
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
  await writeTextFile(path, editorFormatToMarkdown(state.editor.getMarkdown()));
  state.path = path;
  state.dirty = false;
  await updateTitle(state);
  return true;
}

async function save(state: AppState): Promise<boolean> {
  if (!state.path) return saveAs(state);
  await writeTextFile(state.path, editorFormatToMarkdown(state.editor.getMarkdown()));
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

// Theme: three modes — "system" (follow prefers-color-scheme), "light", "dark".
type ThemeMode = "system" | "light" | "dark";

function getThemeMode(): ThemeMode {
  const html = document.documentElement;
  if (html.classList.contains("light")) return "light";
  if (html.classList.contains("dark")) return "dark";
  return "system";
}

function applyThemeMode(mode: ThemeMode) {
  const html = document.documentElement;
  html.classList.remove("light", "dark");
  if (mode === "light") html.classList.add("light");
  else if (mode === "dark") html.classList.add("dark");
  // "system" = no class, CSS @media (prefers-color-scheme) takes over.
  updateThemeButtonLabel();
  try { localStorage.setItem("ai.md.theme", mode); } catch { /* noop */ }
}

function updateThemeButtonLabel() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const mode = getThemeMode();
  btn.textContent = mode === "system" ? "Auto" : mode === "light" ? "Light" : "Dark";
}

function cycleTheme() {
  const order: ThemeMode[] = ["system", "light", "dark"];
  const current = getThemeMode();
  const next = order[(order.indexOf(current) + 1) % order.length];
  applyThemeMode(next);
}

function restoreThemeFromStorage() {
  try {
    const stored = localStorage.getItem("ai.md.theme") as ThemeMode | null;
    if (stored === "light" || stored === "dark" || stored === "system") {
      applyThemeMode(stored);
      return;
    }
  } catch { /* noop */ }
  updateThemeButtonLabel();
}

// Back-compat wrapper: Cmd+Shift+D + menu "Toggle Dark Mode" cycle through modes.
function toggleDarkMode() { cycleTheme(); }

async function exportPdf(state: AppState) {
  // Propose a default filename based on the open file
  const defaultName = state.path
    ? (state.path.split("/").pop() || "document").replace(/\.md$/i, ".pdf")
    : "Untitled.pdf";

  // Ask where to save — this is the export dialog the user wants
  const target = await saveDialog({
    defaultPath: defaultName,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!target) return;

  // Force light theme while rendering so PDF has white background + black text
  const html = document.documentElement;
  const hadDark = html.classList.contains("dark");
  const hadLight = html.classList.contains("light");
  html.classList.remove("dark");
  html.classList.add("light");

  try {
    const el = document.querySelector(".milkdown") as HTMLElement | null;
    if (!el) throw new Error("editor content not found");

    // Re-run column sizing under the light theme in case fonts render differently
    sizeAllTables(() => state.editor.getCtx());

    // html2pdf's TS types miss a few options we need; cast to allow them.
    const opts = {
      margin: [14, 14, 14, 14],                             // mm
      image: { type: "jpeg", quality: 0.95 },
      html2canvas: { scale: 2, backgroundColor: "#ffffff", useCORS: true },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"] },
    } as any;

    const blob = (await html2pdf()
      .from(el)
      .set(opts)
      .outputPdf("blob")) as Blob;

    const bytes = new Uint8Array(await blob.arrayBuffer());
    await writeFile(target, bytes);
  } catch (err) {
    console.error("export PDF failed:", err);
    await ask(`PDF export failed: ${err}`, { title: "ai.md", kind: "error" });
  } finally {
    // Restore theme
    html.classList.remove("light");
    if (hadDark) html.classList.add("dark");
    if (hadLight) html.classList.add("light");
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

  // Restore persisted theme choice (or show "Auto" for system default)
  restoreThemeFromStorage();

  // Wire up toolbar buttons
  document.getElementById("theme-toggle")?.addEventListener("click", cycleTheme);
  document.getElementById("font-toggle")?.addEventListener("click", toggleFont);
  document.getElementById("export-btn")?.addEventListener("click", () => exportPdf(state));

  // Install window-resize → sizer; openFile triggers it directly on load.
  installAutoSizer(() => state.editor.getCtx());

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
      case "export-pdf": await exportPdf(state); break;
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
