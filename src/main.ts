import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readTextFile, writeTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { open as openDialog, save as saveDialog, ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import html2pdf from "html2pdf.js";
import { createEditor, type EditorHandle } from "./editor";
import { installAutoSizer, sizeAllTables } from "./table-sizer";

interface AppState {
  path: string | null;
  dirty: boolean;
  editor: EditorHandle;
  viewMode: ViewMode;
}

type ViewMode = "rendered" | "source";

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

async function updateTitle(state: AppState) {
  const name = state.path ? basename(state.path) : "Untitled";
  const dot = state.dirty ? "● " : "";
  await getCurrentWindow().setTitle(`${dot}${name} — iso.md`);

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

function setWelcomeVisible(visible: boolean) {
  const el = document.getElementById("welcome");
  if (el) el.hidden = !visible;
}

async function openFile(state: AppState, path: string) {
  try {
    const content = await readTextFile(path);
    if (state.viewMode === "source") {
      getSourceTextarea().value = content;
    } else {
      await state.editor.setMarkdown(markdownToEditorFormat(content));
    }
    state.path = path;
    state.dirty = false;
    setWelcomeVisible(false);
    await updateTitle(state);
    if (state.viewMode === "source") getSourceTextarea().focus();
    else state.editor.focus();
    // Point the filesystem watcher at the newly-opened file so we get
    // notified when an external tool (coding agent, editor, build script)
    // rewrites it.
    invoke("watch_file", { path }).catch((err) => console.error("watch_file failed:", err));
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
    await ask(`Could not open file:\n${err}`, { title: "iso.md", kind: "error" });
  }
}

async function openFileDialog(state: AppState) {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] }],
  });
  if (typeof selected === "string") await openFile(state, selected);
}

function currentMarkdownForSave(state: AppState): string {
  // In source mode the textarea already holds on-disk format; in
  // rendered mode we need to reverse the yaml-fence preprocessing.
  return state.viewMode === "source"
    ? getSourceTextarea().value
    : editorFormatToMarkdown(state.editor.getMarkdown());
}

async function saveAs(state: AppState): Promise<boolean> {
  const path = await saveDialog({
    defaultPath: state.path ?? "Untitled.md",
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) return false;
  // Mark before and after the write so the watcher's 750ms suppression
  // window covers however long the underlying fs call takes.
  await invoke("mark_self_write").catch(() => { /* noop */ });
  await writeTextFile(path, currentMarkdownForSave(state));
  await invoke("mark_self_write").catch(() => { /* noop */ });
  state.path = path;
  state.dirty = false;
  await updateTitle(state);
  // Saving with a new path means the watcher needs to follow the new file.
  invoke("watch_file", { path }).catch((err) => console.error("watch_file failed:", err));
  return true;
}

async function save(state: AppState): Promise<boolean> {
  if (!state.path) return saveAs(state);
  await invoke("mark_self_write").catch(() => { /* noop */ });
  await writeTextFile(state.path, currentMarkdownForSave(state));
  await invoke("mark_self_write").catch(() => { /* noop */ });
  state.dirty = false;
  await updateTitle(state);
  return true;
}

async function newFile(state: AppState) {
  if (state.dirty) {
    const keep = await ask("You have unsaved changes. Discard?", {
      title: "iso.md",
      kind: "warning",
    });
    if (!keep) return;
  }
  await state.editor.setMarkdown("");
  getSourceTextarea().value = "";
  state.path = null;
  state.dirty = false;
  setWelcomeVisible(false);
  await updateTitle(state);
  if (state.viewMode === "source") getSourceTextarea().focus();
  else state.editor.focus();
  invoke("unwatch_file").catch(() => { /* noop */ });
}

function getSourceTextarea(): HTMLTextAreaElement {
  return document.getElementById("source-view") as HTMLTextAreaElement;
}

async function setViewMode(state: AppState, mode: ViewMode) {
  if (mode === state.viewMode) return;
  const textarea = getSourceTextarea();
  const btn = document.getElementById("view-toggle");

  if (mode === "source") {
    // Pull current markdown out of the editor in on-disk format
    // (reverse the yaml-fence preprocessing).
    textarea.value = editorFormatToMarkdown(state.editor.getMarkdown());
    document.body.classList.add("source-mode");
    textarea.hidden = false;
    btn?.setAttribute("aria-pressed", "true");
    btn?.setAttribute("title", "Show rendered view");
    textarea.focus();
  } else {
    // Feed the (possibly edited) raw markdown back through the
    // preprocessor and rebuild the editor.
    const md = markdownToEditorFormat(textarea.value);
    textarea.hidden = true;
    document.body.classList.remove("source-mode");
    btn?.setAttribute("aria-pressed", "false");
    btn?.setAttribute("title", "Toggle source view");
    await state.editor.setMarkdown(md);
    state.editor.focus();
  }

  state.viewMode = mode;
  try { localStorage.setItem("iso.md.view-mode", mode); } catch { /* noop */ }
}

function restoreViewModeFromStorage(state: AppState) {
  try {
    const stored = localStorage.getItem("iso.md.view-mode");
    if (stored === "source") {
      // Fire-and-forget — setViewMode is async but we only chain it
      // after any pending file load has populated the editor.
      void setViewMode(state, "source");
    }
  } catch { /* noop */ }
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
  try { localStorage.setItem("iso.md.theme", mode); } catch { /* noop */ }
}

function updateThemeButtonLabel() {
  // The mode is reflected on <html> via the class; the button keeps its
  // SVG icon. We only refresh the title tooltip so it shows the current
  // mode when hovered.
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const mode = getThemeMode();
  const name = mode === "system" ? "Auto" : mode === "light" ? "Light" : "Dark";
  btn.setAttribute("title", `Theme: ${name}`);
}

function cycleTheme() {
  const order: ThemeMode[] = ["system", "light", "dark"];
  const current = getThemeMode();
  const next = order[(order.indexOf(current) + 1) % order.length];
  applyThemeMode(next);
}

function restoreThemeFromStorage() {
  try {
    const stored = localStorage.getItem("iso.md.theme") as ThemeMode | null;
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

  // Apply export-mode styles: full-width content, hidden chrome,
  // page-break-inside: avoid on blocks. See styles.css `body.exporting`.
  document.body.classList.add("exporting");

  // Belt-and-braces: set an explicit inline width on .milkdown and its
  // parent so there is zero chance of the 540px --content-max sneaking
  // through via specificity or html2canvas clone quirks. We target A4
  // content area at 96dpi (210mm - 28mm margins ≈ 688px).
  const editorEl = document.getElementById("editor");
  const milkdownEl = document.querySelector(".milkdown") as HTMLElement | null;
  const saved = {
    editorWidth: editorEl?.style.width ?? "",
    editorMax: editorEl?.style.maxWidth ?? "",
    editorPad: editorEl?.style.padding ?? "",
    editorDisplay: editorEl?.style.display ?? "",
    mdWidth: milkdownEl?.style.width ?? "",
    mdMax: milkdownEl?.style.maxWidth ?? "",
  };
  const PRINT_CONTENT_PX = 688;
  if (editorEl) {
    editorEl.style.width = `${PRINT_CONTENT_PX}px`;
    editorEl.style.maxWidth = `${PRINT_CONTENT_PX}px`;
    editorEl.style.padding = "0";
    editorEl.style.display = "block";
  }
  if (milkdownEl) {
    milkdownEl.style.width = `${PRINT_CONTENT_PX}px`;
    milkdownEl.style.maxWidth = `${PRINT_CONTENT_PX}px`;
  }

  try {
    if (!milkdownEl) throw new Error("editor content not found");

    // Re-run column sizing under the light theme in case fonts render differently
    sizeAllTables(() => state.editor.getCtx());

    // Give the browser a frame to apply the new layout before snapshotting.
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    // Match the canvas window to the element width so html2canvas doesn't
    // capture extra whitespace from the surrounding (wider) viewport.
    const renderWidth = PRINT_CONTENT_PX;

    // html2pdf's TS types miss a few options we need; cast to allow them.
    const opts = {
      margin: [14, 14, 14, 14],                             // mm
      image: { type: "jpeg", quality: 0.95 },
      html2canvas: {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
        windowWidth: renderWidth,
        width: renderWidth,
        // Mutate the cloned document right before rendering. This is
        // the only way to guarantee the .milkdown max-width constraint
        // is gone — inline styles on the live DOM don't always survive
        // the html2canvas clone step in a predictable order.
        onclone: (doc: Document) => {
          const body = doc.body;
          const editor = doc.getElementById("editor");
          const md = doc.querySelector(".milkdown") as HTMLElement | null;
          if (body) {
            body.style.width = `${renderWidth}px`;
            body.style.margin = "0";
            body.style.padding = "0";
            body.style.background = "#ffffff";
          }
          if (editor) {
            editor.style.width = `${renderWidth}px`;
            editor.style.maxWidth = `${renderWidth}px`;
            editor.style.padding = "0";
            editor.style.margin = "0";
            editor.style.display = "block";
          }
          if (md) {
            md.style.width = `${renderWidth}px`;
            md.style.maxWidth = `${renderWidth}px`;
            md.style.margin = "0";
            md.style.padding = "0";
          }
          // Hide UI chrome in the clone just in case body.exporting didn't apply.
          doc.querySelectorAll<HTMLElement>(".titlebar, .toolbar, .welcome")
            .forEach((n) => { n.style.display = "none"; });
        },
      },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      // `avoid-all` tries not to split block elements across pages,
      // combined with break-inside: avoid in CSS this stops mid-line cuts.
      pagebreak: { mode: ["avoid-all", "css", "legacy"] },
    } as any;

    // Render the whole body so the canvas is exactly renderWidth wide.
    // Passing .milkdown alone can produce a narrower canvas when layout
    // state (flex parent, margin:auto, etc.) isn't fully honored.
    const blob = (await html2pdf()
      .from(document.body)
      .set(opts)
      .outputPdf("blob")) as Blob;

    const bytes = new Uint8Array(await blob.arrayBuffer());
    await writeFile(target, bytes);
  } catch (err) {
    console.error("export PDF failed:", err);
    await ask(`PDF export failed: ${err}`, { title: "iso.md", kind: "error" });
  } finally {
    // Restore inline styles
    if (editorEl) {
      editorEl.style.width = saved.editorWidth;
      editorEl.style.maxWidth = saved.editorMax;
      editorEl.style.padding = saved.editorPad;
      editorEl.style.display = saved.editorDisplay;
    }
    if (milkdownEl) {
      milkdownEl.style.width = saved.mdWidth;
      milkdownEl.style.maxWidth = saved.mdMax;
    }
    // Restore theme + drop export class
    document.body.classList.remove("exporting");
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
  document.getElementById("new-btn")?.addEventListener("click", () => newFile(state));
  document.getElementById("open-btn")?.addEventListener("click", () => openFileDialog(state));
  // Theme menu: hover reveals three options. Clicking the trigger itself
  // also cycles (keyboard / tap fallback on machines without hover).
  document.getElementById("theme-toggle")?.addEventListener("click", cycleTheme);
  document.querySelectorAll<HTMLButtonElement>(".theme-menu-dropdown button[data-theme]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const mode = btn.dataset.theme as ThemeMode;
      applyThemeMode(mode);
      // Drop hover focus so the dropdown closes after selection.
      (document.activeElement as HTMLElement | null)?.blur();
    });
  });
  document.getElementById("font-toggle")?.addEventListener("click", toggleFont);
  document.getElementById("export-btn")?.addEventListener("click", () => exportPdf(state));
  document.getElementById("view-toggle")?.addEventListener("click", () => {
    setViewMode(state, state.viewMode === "rendered" ? "source" : "rendered");
  });

  // Source-view textarea: typing dirties the file, same as the editor's
  // onChange path below.
  getSourceTextarea().addEventListener("input", async () => {
    if (!state.dirty) {
      state.dirty = true;
      await updateTitle(state);
    }
  });

  // Welcome overlay — shown on cold launch with no file
  document.getElementById("welcome-new")?.addEventListener("click", () => newFile(state));
  document.getElementById("welcome-open")?.addEventListener("click", () => openFileDialog(state));

  // Install window-resize → sizer; openFile triggers it directly on load.
  installAutoSizer(() => state.editor.getCtx());

  // Window dragging via the top bar. CSS `-webkit-app-region: drag` is
  // unreliable with titleBarStyle: "Overlay" in Tauri/WebKit, so we
  // drive the drag ourselves: on mousedown over the titlebar or empty
  // toolbar gaps, call the backend's startDragging(). Buttons and
  // interactive elements are excluded so clicks still register there.
  const startDragIfNotInteractive = async (e: Event) => {
    const me = e as MouseEvent;
    if (me.button !== 0) return;
    const target = me.target as HTMLElement;
    if (target.closest("button, input, textarea, a, [contenteditable]")) return;
    try {
      await getCurrentWindow().startDragging();
    } catch (err) {
      console.error("startDragging failed:", err);
    }
  };
  document.querySelector(".titlebar")?.addEventListener("mousedown", startDragIfNotInteractive);
  document.querySelector(".toolbar")?.addEventListener("mousedown", startDragIfNotInteractive);

  // Double-clicking the titlebar toggles maximize, matching macOS convention.
  document.querySelector(".titlebar")?.addEventListener("dblclick", async (e) => {
    const target = (e as MouseEvent).target as HTMLElement;
    if (target.closest("button")) return;
    const win = getCurrentWindow();
    const isMax = await win.isMaximized();
    if (isMax) await win.unmaximize(); else await win.maximize();
  });

  // Clicking anywhere inside the editor pane — even outside the narrow
  // .ProseMirror column — should focus the document so the cursor is
  // visible. Native clicks inside .ProseMirror already position the
  // caret; we only take over when the click lands on empty padding.
  root.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest(".ProseMirror")) {
      e.preventDefault();
      state.editor.focus();
    }
  });

  // Make inline links clickable. ProseMirror swallows clicks on anchor
  // tags to position the caret inside them, so we intercept and route
  // http(s)/mailto links through Tauri's opener plugin (system browser
  // / mail client). Internal anchors (#hash) and javascript: links are
  // ignored. Plain left-click only — modifier-clicks fall through so
  // the user can still position the cursor with cmd-click if needed.
  root.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const target = e.target as HTMLElement;
    const anchor = target.closest("a") as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    if (/^(https?:|mailto:)/i.test(href)) {
      e.preventDefault();
      e.stopPropagation();
      openUrl(href).catch((err) => console.error("openUrl failed:", err));
    }
  });

  const state: AppState = { path: null, dirty: false, editor, viewMode: "rendered" };
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

  // External rewrite of the open file (coding agent, editor, build script).
  // Reload silently if we have no unsaved edits; otherwise prompt before
  // discarding the user's changes.
  await listen<string>("file-changed", async (ev) => {
    if (!state.path || ev.payload !== state.path) return;
    if (state.dirty) {
      const reload = await ask(
        "This file was changed by another program. Reload and discard your edits?",
        { title: "iso.md", kind: "warning" }
      );
      if (!reload) return;
    }
    const scrollY = window.scrollY;
    await openFile(state, state.path);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    }));
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

  // Show welcome overlay if we booted without any file
  if (!state.path) setWelcomeVisible(true);

  // Restore source/rendered preference last, so any pending file load
  // has already populated the editor we're about to read from.
  restoreViewModeFromStorage(state);

  // Confirm close if dirty
  const win = getCurrentWindow();
  await win.onCloseRequested(async (event) => {
    if (state.dirty) {
      const discard = await ask("You have unsaved changes. Close without saving?", {
        title: "iso.md",
        kind: "warning",
      });
      if (!discard) event.preventDefault();
    }
  });

  // WKWebView in Tauri sometimes resets window scrollY to 0 when the app
  // loses and regains focus (switching apps, ⌘-tab, etc.). Track the latest
  // scroll position continuously and restore it after focus / visibility
  // change so the user lands back at the same line they left at.
  let lastScrollY = 0;
  window.addEventListener("scroll", () => { lastScrollY = window.scrollY; }, { passive: true });
  const restoreScroll = () => {
    // Defer two frames: one for layout to settle, one to override any
    // scroll-to-top that WKWebView fires after focus.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (window.scrollY !== lastScrollY) window.scrollTo(0, lastScrollY);
    }));
  };
  window.addEventListener("focus", restoreScroll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") restoreScroll();
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
