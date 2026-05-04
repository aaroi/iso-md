/**
 * Content-adaptive column sizing — stylesheet-injection approach.
 *
 * CSS `table-layout: auto` can't reliably give text-heavy columns more
 * space than numeric ones in WebKit, and setting inline styles on
 * individual <td>/<col> elements gets wiped when ProseMirror replaces
 * the table's DOM on state changes. ProseMirror doesn't manage <style>
 * elements in <head>, so rules injected there are immune to DOM churn.
 *
 * Strategy:
 *   1. Measure each cell's natural (no-wrap) text width via a probe
 *   2. Per column: take max across rows, cap at CAP_PX, pad + floor
 *   3. If the natural total is narrower than the prose column's
 *      --content-max, scale columns up proportionally so the table
 *      isn't visually narrower than surrounding paragraphs
 *   4. Emit pixel-width CSS rules into <style id="iso-md-table-widths">
 *   5. The core table CSS (table-layout: fixed, width: max-content,
 *      left-aligned) lives in the main stylesheet
 */

// Min floor per column — prevents crushing on small windows.
const MIN_COL_PX = 60;
// Max per column — beyond this, text wraps. Tuned so long prose cells
// (~370px unwrapped) fit on one line without a column eating the page.
const CAP_PX = 520;
const CELL_PADDING_PX = 16;

const STYLE_ID = "iso-md-table-widths";

function measureCellWidth(cell: HTMLElement): number {
  const text = (cell.textContent || "").trim();
  if (!text) return MIN_COL_PX;
  const styleSource = (cell.querySelector("strong, em, code, b, i") as HTMLElement) || cell;
  const cs = getComputedStyle(styleSource);
  const probe = document.createElement("span");
  probe.style.cssText = [
    "position:absolute", "left:-99999px", "top:-99999px",
    "visibility:hidden", "white-space:nowrap",
    "padding:0", "margin:0", "border:0",
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

/**
 * Compute per-column PIXEL widths for one table.
 *
 * Each column width = measured_content + padding, clamped to
 * [MIN_COL_PX, CAP_PX + padding]. Returning pixel widths (not
 * percentages) means the table's width = sum of columns. Short
 * columns stay short, long columns get the room they need, and
 * no forced distribution robs a text-heavy column to feed a
 * numeric one.
 */
function computeTableWidths(table: HTMLTableElement): number[] | null {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (!rows.length) return null;
  const numCols = rows.reduce((m, r) => Math.max(m, r.children.length), 0);
  if (numCols <= 1) return null;

  const colPx = new Array(numCols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.children.length && i < numCols; i++) {
      const w = measureCellWidth(row.children[i] as HTMLElement);
      if (w > colPx[i]) colPx[i] = w;
    }
  }

  let widths = colPx.map(w => {
    const desired = Math.min(w, CAP_PX) + CELL_PADDING_PX;
    return Math.max(MIN_COL_PX, Math.round(desired));
  });

  // Tables should be at least as wide as the prose column below them —
  // a 2-col reference table shouldn't look visually narrower than the
  // paragraphs around it. Scale columns up proportionally if the natural
  // sum is below --content-max.
  const contentMaxStr = getComputedStyle(document.documentElement)
    .getPropertyValue("--content-max").trim();
  const contentMaxPx = parseFloat(contentMaxStr) || 540;
  const naturalTotal = widths.reduce((a, b) => a + b, 0);
  if (naturalTotal > 0 && naturalTotal < contentMaxPx) {
    const scale = contentMaxPx / naturalTotal;
    widths = widths.map(w => Math.round(w * scale));
  }

  return widths;
}

/**
 * Size all tables in the editor by injecting CSS rules into <head>.
 * Stylesheets survive ProseMirror DOM replacements, so widths stay.
 */
/**
 * Ensure each table is inside a `.table-scroll-wrap` <div> so wide
 * tables get their own horizontal scrollbar instead of making the
 * whole page scroll.
 */
import { editorViewCtx } from "@milkdown/core";
import type { Ctx } from "@milkdown/ctx";
import type { EditorView } from "@milkdown/prose/view";

/**
 * Apply computed widths via ProseMirror's `colwidth` cell attribute.
 *
 * prosemirror-tables' TableView.updateColumns() actively manages <col>
 * widths on every node update — it reads each cell's colwidth attr
 * from the PM doc and writes the corresponding style.width onto the
 * <col>. If colwidth is absent it writes style.width = "", wiping
 * anything we set from outside. So the only stable way to size
 * columns is to put the widths IN the PM doc. Then PM renders them.
 */
function applyWidthsViaPmAttrs(view: EditorView): boolean {
  let tr = view.state.tr;
  let dirty = false;

  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "table") return true;

    // Measure the DOM table to get per-column target widths.
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    const domTable = dom?.tagName === "TABLE"
      ? (dom as HTMLTableElement)
      : (dom?.querySelector("table") as HTMLTableElement | null);
    if (!domTable) return false;

    const widths = computeTableWidths(domTable);
    if (!widths) return false;

    // Set colwidth on each cell in the first row. `rowPos` points
    // inside the table (after its opening token). `cellPos` points
    // inside the row.
    const firstRow = node.firstChild;
    if (!firstRow) return false;
    const rowPos = pos + 1;
    firstRow.forEach((cell, cellOffset, cellIdx) => {
      if (cellIdx >= widths.length) return;
      const target = widths[cellIdx];
      const current = cell.attrs.colwidth as number[] | null;
      if (!current || current[0] !== target || current.length !== 1) {
        const cellPos = rowPos + 1 + cellOffset;
        tr = tr.setNodeMarkup(cellPos, undefined, {
          ...cell.attrs,
          colwidth: [target],
        });
        dirty = true;
      }
    });

    return false; // don't descend into the table
  });

  if (dirty) {
    tr.setMeta("addToHistory", false);
    view.dispatch(tr);
  }
  return dirty;
}

export function sizeAllTables(getCtx?: () => Ctx | null): void {
  if (!getCtx) return;
  try {
    const ctx = getCtx();
    if (!ctx) return;
    const view = ctx.get(editorViewCtx) as EditorView;
    applyWidthsViaPmAttrs(view);
  } catch (err) {
    console.error("sizeAllTables failed:", err);
  }

  // Clear any leftover stylesheet rules from the previous approach.
  const staleStyle = document.getElementById(STYLE_ID);
  if (staleStyle) staleStyle.textContent = "";
}

/**
 * Install a sizer that re-runs on window resize. `getCtx` must
 * return the current editor's Milkdown ctx so the sizer can reach
 * the PM view.
 */
export function installAutoSizer(getCtx: () => Ctx | null): () => void {
  let pending = 0;
  const schedule = () => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      pending = 0;
      sizeAllTables(getCtx);
    });
  };

  const onResize = () => schedule();
  window.addEventListener("resize", onResize);
  schedule();

  return () => {
    window.removeEventListener("resize", onResize);
    if (pending) cancelAnimationFrame(pending);
  };
}
