# ai.md

A minimal, monospace markdown editor for macOS. Live-preview editing,
PDF export, system-font and light/dark toggles, and it opens `.md`
files straight from Finder.

Built with Tauri v2 + Milkdown. The shipped `.app` is about 9–10 MB.

## Features

- **Live markdown preview** — Typora-style, powered by Milkdown +
  CommonMark + GFM (tables, task lists, strikethrough).
- **Grayscale, monospace UI** — no color noise, Notion-ish spacing,
  follows the macOS system appearance by default.
- **Content-adaptive table columns** — columns are sized in pixels from
  each cell's natural text width; long-text columns get wider, numeric
  columns stay tight. Small tables still expand to the width of the
  prose column so they don't look narrower than the paragraphs around
  them.
- **PDF export** — toolbar button or `⌘E` opens a save dialog, picks a
  filename and location, then writes a PDF of the rendered document.
- **`.md` file association** — registers as an editor for
  `net.daringfireball.markdown`, so double-clicking any `.md` in Finder
  opens it in ai.md.
- **Toolbar** — three small buttons in the top-right:
  - `Auto / Light / Dark` — cycle theme; "Auto" follows the system.
  - `Aa` — toggle between the monospace stack and the system UI font.
  - `PDF` — export the current document.
- **Zoom** — `⌘=` / `⌘-` / `⌘0`.
- **Undo/redo** — `⌘Z` / `⇧⌘Z` (and `Ctrl-Z` / `Ctrl-Shift-Z`).
- **Window** — opens full screen height, docked to the left edge of the
  display.

## Install from source

Prerequisites on macOS:
- [Homebrew](https://brew.sh)
- Node 20+ (via nvm, asdf, or Homebrew)
- Rust toolchain via rustup

```bash
# One-time setup
brew install rustup pnpm
rustup default stable
export PATH="$HOME/.cargo/bin:$PATH"

# Clone and build
git clone https://github.com/aaroi/ai-md.git
cd ai-md
pnpm install
pnpm tauri build

# Install the bundle
cp -R src-tauri/target/release/bundle/macos/ai.md.app /Applications/
```

After installing, Finder's "Open With → ai.md" will appear for `.md`
files. To make ai.md the **default** handler system-wide:

```bash
# Via Swift one-liner (no extra deps)
swift -e 'import Cocoa
LSSetDefaultRoleHandlerForContentType(
  "net.daringfireball.markdown" as CFString,
  .all,
  "com.aaro.aimd" as CFString
)'
```

## Development

```bash
pnpm tauri dev      # hot-reload dev window, DevTools attached
pnpm build          # frontend type-check + Vite bundle
pnpm tauri build    # full production .app
```

## Project layout

```
src/                    Frontend (TypeScript)
├── main.ts             App bootstrap, toolbar, menu wiring, file I/O
├── editor.ts           Milkdown setup (CommonMark, GFM, history)
├── table-sizer.ts      Content-adaptive table column widths
├── styles.css          Grayscale theme, mono/system font, print CSS
└── print.css           Print-media overrides for PDF export

src-tauri/              Rust backend
├── src/lib.rs          Menu, window sizing, file-open events
├── tauri.conf.json     Bundle config, file associations
└── capabilities/       Plugin permissions
```

## Tech stack

- **[Tauri v2](https://tauri.app)** — Rust backend + WKWebView frontend
- **[Milkdown](https://milkdown.dev)** — ProseMirror-based WYSIWYG
  markdown (`preset-commonmark`, `preset-gfm`, `plugin-history`,
  `plugin-listener`)
- **[Vite](https://vite.dev) + TypeScript** — frontend build
- **[html2pdf.js](https://github.com/eKoopmans/html2pdf.js)** — in-webview
  PDF rendering for the export feature

## Notes

The table column sizing is a non-obvious piece: CSS `table-layout: auto`
doesn't reliably distribute space proportionally to content in WebKit,
and inline styles on `<td>` / `<col>` elements get orphaned when
ProseMirror replaces table DOM on state changes. The sizer measures
each cell's natural unwrapped text width, computes per-column pixel
widths (clamped to `[60px, 520 + padding]`), and injects them as CSS
rules into a `<style>` element in `<head>` — stylesheets survive PM's
DOM churn because PM doesn't manage `<head>`.
