import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewOptionsCtx,
  prosePluginsCtx,
  schemaCtx,
  serializerCtx,
} from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { history } from "@milkdown/plugin-history";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { getMarkdown } from "@milkdown/utils";
import { keymap } from "@milkdown/prose/keymap";
import { undo, redo } from "@milkdown/prose/history";
import type { Slice } from "@milkdown/prose/model";

// ProseMirror base CSS is inlined into styles.css to keep full control of table layout

export interface EditorHandle {
  getMarkdown(): string;
  setMarkdown(md: string): Promise<void>;
  onChange(cb: (md: string) => void): void;
  /** Access the current editor's Milkdown ctx (null before first create). */
  getCtx(): import("@milkdown/ctx").Ctx | null;
}

export async function createEditor(root: HTMLElement): Promise<EditorHandle> {
  let changeCallback: ((md: string) => void) | null = null;
  let currentEditor: Editor | null = null;

  const buildEditor = async (initial: string): Promise<Editor> => {
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initial);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: { spellcheck: "true", class: "milkdown" },
          // When the user copies text, put MARKDOWN source on the clipboard
          // (not just stripped plain text). ProseMirror's default
          // clipboardTextSerializer uses `slice.content.textBetween(...)`
          // which loses headings, bold, lists, links, etc. We re-serialize
          // the selection as markdown using Milkdown's serializer.
          clipboardTextSerializer: (slice: Slice): string => {
            try {
              const serializer = ctx.get(serializerCtx);
              const schema = ctx.get(schemaCtx);
              // Build a throw-away doc node whose content is the selection
              // so the serializer can walk it top-down.
              let docNode = schema.topNodeType.createAndFill(null, slice.content);
              if (!docNode) {
                // Fragment is inline-only (e.g. copying from inside a paragraph).
                // Wrap it in a paragraph first so `doc` can accept it.
                const para = schema.nodes.paragraph;
                if (para) {
                  const wrapped = para.createAndFill(null, slice.content);
                  if (wrapped) docNode = schema.topNodeType.createAndFill(null, [wrapped]);
                }
              }
              if (!docNode) {
                return slice.content.textBetween(0, slice.content.size, "\n\n");
              }
              return serializer(docNode).trimEnd();
            } catch (err) {
              console.error("clipboardTextSerializer error:", err);
              return slice.content.textBetween(0, slice.content.size, "\n\n");
            }
          },
        }));
        ctx.get(listenerCtx).markdownUpdated((_ctx, md, prev) => {
          if (md !== prev && changeCallback) changeCallback(md);
        });
        // Add literal Ctrl-Z / Ctrl-Shift-Z (in addition to the Cmd-Z /
        // Shift-Cmd-Z bindings already provided by the history plugin).
        ctx.update(prosePluginsCtx, (prev) => [
          keymap({
            "Ctrl-z": undo,
            "Ctrl-Shift-z": redo,
            "Ctrl-y": redo,
          }),
          ...prev,
        ]);
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .create();
    return editor;
  };

  currentEditor = await buildEditor("");

  return {
    getMarkdown(): string {
      if (!currentEditor) return "";
      return currentEditor.action(getMarkdown());
    },
    async setMarkdown(md: string) {
      if (currentEditor) await currentEditor.destroy();
      root.innerHTML = "";
      currentEditor = await buildEditor(md);
    },
    onChange(cb) {
      changeCallback = cb;
    },
    getCtx() {
      if (!currentEditor) return null;
      let ctx: import("@milkdown/ctx").Ctx | null = null;
      currentEditor.action((c) => { ctx = c; });
      return ctx;
    },
  };
}
