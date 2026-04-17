# ai.md

**A minimal monospace markdown editor for macOS.**

No cloud, no telemetry, no AI (despite the name — that's for later).
Just a terminal-feeling WYSIWYG editor that opens `.md` files from
Finder, exports clean PDFs, and gets out of your way.

Built on Tauri v2 + Milkdown. The shipped `.app` is ~10 MB.

---

## Highlights

- **Live preview, Typora-style.** Markdown renders inline as you type,
  powered by Milkdown + ProseMirror + remark (CommonMark & GFM: tables,
  task lists, strikethrough).
- **Monospace by default, system font one click away.** Toggle in the
  top-right toolbar.
- **Grayscale UI, light/dark/auto.** No blue tints, no color noise.
  Follows macOS appearance, or pick a mode manually.
- **Tables that actually look like tables.** Column widths adapt to the
  content on the page — numeric columns stay tight, prose columns get
  wider. Never narrower than the surrounding paragraphs.
- **Real PDF export.** `⌘E` (or the toolbar button) opens a save dialog
  — pick a name and location, get a clean PDF.
- **Finder integration.** Double-click any `.md` file and it opens in
  ai.md.
- **Keyboard-first.** `⌘Z` / `⇧⌘Z` undo, `⌘=` / `⌘-` / `⌘0` zoom,
  `⌘S` / `⌘O` save/open, `⌘⇧D` theme.
- **Left-aligned, full-height, pinned to the left of your screen.**
  Optimized for writing alongside something else (docs, browser,
  Figma).

## Quickstart — download the built app

If you don't want to build from source, grab the latest `.app` from the
**Releases** page (or ask the person who sent you this repo — they
probably have a build handy), drag it to `/Applications/`, then:

```bash
# Make ai.md the default handler for .md files (optional)
swift -e 'import Cocoa
LSSetDefaultRoleHandlerForContentType(
  "net.daringfireball.markdown" as CFString,
  .all,
  "com.aaro.aimd" as CFString
)'
```

## Build from source

**Requires:** macOS, Node 20+, [pnpm](https://pnpm.io), and a Rust
toolchain via rustup.

```bash
# One-time toolchain setup
brew install rustup pnpm
rustup default stable
export PATH="$HOME/.cargo/bin:$PATH"

# Clone + build
git clone https://github.com/aaroi/ai-md.git
cd ai-md
pnpm install
pnpm tauri build

# Install to /Applications
cp -R src-tauri/target/release/bundle/macos/ai.md.app /Applications/
```

First build takes a few minutes (Rust crate compile). Subsequent builds
are ~30 seconds.

## Development

```bash
pnpm tauri dev      # hot-reload dev window with DevTools attached
pnpm build          # frontend type-check + Vite bundle
pnpm tauri build    # full production .app
```

The Tauri dev window auto-opens DevTools. In release builds, the
`devtools` feature is enabled — right-click → Inspect to open the
inspector if you need to debug.

## Project layout

```
src/                    Frontend (TypeScript + Vite)
├── main.ts             App bootstrap, toolbar, menu, file I/O, PDF export
├── editor.ts           Milkdown setup (CommonMark, GFM, history)
├── table-sizer.ts      Content-adaptive column widths (see note below)
├── styles.css          Grayscale theme, mono/system font
└── print.css           Print-media overrides for PDF export

src-tauri/              Rust backend (Tauri v2)
├── src/lib.rs          Menu, window sizing, Finder-open events
├── tauri.conf.json     Bundle config + file association
└── capabilities/       fs & dialog permissions
```

## Tech stack

| Layer        | What                                                  |
|--------------|-------------------------------------------------------|
| Shell        | [Tauri v2](https://tauri.app) (Rust + WKWebView)       |
| Editor       | [Milkdown](https://milkdown.dev) (ProseMirror + remark) |
| Build        | [Vite](https://vite.dev) + TypeScript                   |
| PDF          | [html2pdf.js](https://github.com/eKoopmans/html2pdf.js) |
| Font stack   | `ui-monospace, "SF Mono", Menlo, …`                    |

## Permissions & security

The app uses Tauri's fine-grained permission system:

- **Filesystem** — read/write text files under `$HOME`, `$DOCUMENTS`,
  `$DESKTOP`, `$DOWNLOADS`, and `$TEMP`. No other paths are reachable.
  See `src-tauri/capabilities/default.json`.
- **Dialog** — open/save/ask dialogs (native macOS sheets).
- **No network access.** No analytics, no auto-update, no telemetry.

If a teammate opens a `.md` file outside one of those directories, the
read will fail. Adjust the scope list in `capabilities/default.json`
if you need broader access.

## Note on table column widths

Getting content-adaptive columns in a ProseMirror editor is surprisingly
hard:

1. CSS `table-layout: auto` distributes space near-evenly in WebKit,
   regardless of content length.
2. Setting inline styles on individual `<td>` / `<col>` elements gets
   wiped when ProseMirror replaces table DOM on state updates.

The working answer is to measure each cell's natural (no-wrap) text
width in JS, compute per-column pixel widths (clamped to
`[60px, 520 + padding]`), and inject them as CSS rules into a
`<style>` element in `<head>`. ProseMirror doesn't manage `<head>`, so
the rules survive its DOM churn. Tables scale up to match the prose
column width if their content is narrower than the text below them.

The full logic lives in `src/table-sizer.ts` (about 150 lines).

## License

[MIT](LICENSE) © 2026 Aaro Isosaari
