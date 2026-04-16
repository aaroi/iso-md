import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, prosePluginsCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { history } from "@milkdown/plugin-history";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { getMarkdown } from "@milkdown/utils";
import { keymap } from "@milkdown/prose/keymap";
import { undo, redo } from "@milkdown/prose/history";

// ProseMirror base CSS is inlined into styles.css to keep full control of table layout

export interface EditorHandle {
  getMarkdown(): string;
  setMarkdown(md: string): Promise<void>;
  onChange(cb: (md: string) => void): void;
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
  };
}
