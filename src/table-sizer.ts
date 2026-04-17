/**
 * Content-adaptive table column sizing.
 *
 * CSS `table-layout: auto` is unreliable across browsers — WebKit in
 * particular doesn't distribute space proportionally to max-content
 * the way the spec suggests. To guarantee wider columns for cells
 * with more content, we measure each cell's natural (unwrapped) text
 * width in JavaScript, cap it, then apply explicit percentage widths
 * via <colgroup>/<col> elements with `table-layout: fixed`.
 *
 * Per-column width = max(measured_cell_widths_in_column) + padding,
 *                    capped at MAX_COL_PX so long prose wraps.
 * Widths are applied as percentages so the table stays responsive to
 * the wrapper's own width changes.
 */

const CAP_PX = 360;          // max per-column width before text wraps
const MIN_PX = 32;           // floor so single-char cells still have room
const CELL_PADDING_PX = 16;  // matches 6px 8px padding (~8+8 horiz)

/** Measure the natural (no-wrap) text width of a cell in device pixels. */
function measureCellWidth(cell: HTMLElement): number {
  const text = (cell.textContent || "").trim();
  if (!text) return MIN_PX;

  const cs = getComputedStyle(cell);
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = [
    "position:absolute",
    "left:-99999px",
    "top:-99999px",
    "visibility:hidden",
    "white-space:nowrap",
    "padding:0",
    "margin:0",
    "border:0",
    `font-family:${cs.fontFamily}`,
    `font-size:${cs.fontSize}`,
    `font-weight:${cs.fontWeight}`,
    `font-style:${cs.fontStyle}`,
    `letter-spacing:${cs.letterSpacing}`,
  ].join(";");
  probe.textContent = text;
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  return w;
}

export function sizeTable(table: HTMLTableElement): void {
  // Collect rows (thead + tbody)
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return;

  const numCols = rows.reduce((max, r) => Math.max(max, r.children.length), 0);
  if (numCols <= 1) return;

  // Per-column: max measured width across all rows
  const colPx: number[] = new Array(numCols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.children.length && i < numCols; i++) {
      const cell = row.children[i] as HTMLElement;
      const w = measureCellWidth(cell);
      if (w > colPx[i]) colPx[i] = w;
    }
  }

  // Cap, add padding, enforce floor
  const capped = colPx.map(w => {
    const desired = Math.min(w, CAP_PX) + CELL_PADDING_PX;
    return Math.max(desired, MIN_PX + CELL_PADDING_PX);
  });

  const total = capped.reduce((a, b) => a + b, 0);
  if (total === 0) return;

  // Ensure a <colgroup> exists with the right number of <col> children.
  // ProseMirror's table node view renders its own colgroup; reuse if present.
  let colgroup = table.querySelector(":scope > colgroup");
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    table.insertBefore(colgroup, table.firstChild);
  }
  while (colgroup.children.length < numCols) {
    colgroup.appendChild(document.createElement("col"));
  }
  while (colgroup.children.length > numCols) {
    colgroup.lastElementChild!.remove();
  }

  // Apply widths as percentages so the table is still responsive.
  const cols = Array.from(colgroup.children) as HTMLElement[];
  cols.forEach((col, i) => {
    const pct = (capped[i] / total) * 100;
    col.style.width = `${pct.toFixed(3)}%`;
  });

  // Fixed layout forces the browser to honor the <col> widths instead of
  // its own heuristic.
  table.style.tableLayout = "fixed";
  // Let the table stretch to fill the wrapper; individual columns keep
  // their proportions.
  table.style.width = "100%";
}

export function sizeAllTables(root: ParentNode = document): void {
  const tables = root.querySelectorAll("table");
  tables.forEach(t => sizeTable(t as HTMLTableElement));
}

/**
 * Install a debounced auto-sizer that re-runs whenever tables are
 * added, removed, or their text content changes.
 */
export function installAutoSizer(editorRoot: Element): () => void {
  let pending = 0;
  const schedule = () => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      pending = 0;
      sizeAllTables(editorRoot);
    });
  };

  const observer = new MutationObserver(mutations => {
    // Only resize if a table or cell changed (not every caret move).
    for (const m of mutations) {
      if (
        (m.target as Element).closest?.("table") ||
        Array.from(m.addedNodes).some(n =>
          (n as Element).nodeType === 1 &&
          ((n as Element).matches?.("table") || (n as Element).querySelector?.("table"))
        )
      ) {
        schedule();
        return;
      }
    }
  });

  observer.observe(editorRoot, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Resize on window resize too (percentage widths stay correct but
  // cap may want re-evaluation if content grew).
  const onResize = () => schedule();
  window.addEventListener("resize", onResize);

  // Initial sizing.
  schedule();

  return () => {
    observer.disconnect();
    window.removeEventListener("resize", onResize);
    if (pending) cancelAnimationFrame(pending);
  };
}
