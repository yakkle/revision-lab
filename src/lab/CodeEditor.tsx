import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { StreamLanguage } from "@codemirror/language";
import { properties } from "@codemirror/legacy-modes/mode/properties";

export function CodeEditor({ path, value, disabled, onChange }: {
  path: string; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>(undefined);
  const callback = useRef(onChange);
  useEffect(() => { callback.current = onChange; }, [onChange]);
  useEffect(() => {
    if (!host.current) return;
    const language = path.endsWith(".py") ? python() : path.endsWith(".sql") ? sql() : StreamLanguage.define(properties);
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions: [
      basicSetup, language, EditorView.theme({ "&": { height: "100%", backgroundColor: "#121713", color: "#e8ecdf" },
        ".cm-scroller": { overflow: "auto", fontFamily: "monospace" }, ".cm-gutters": { backgroundColor: "#171e18", color: "#98a692", border: "none" },
        ".cm-content": { caretColor: "#c8f169" }, ".cm-activeLine": { backgroundColor: "#253022" } }, { dark: true }),
      EditorView.contentAttributes.of({ "aria-label": `코드 편집기 ${path}` }),
      EditorView.updateListener.of((update) => { if (update.docChanged) callback.current(update.state.doc.toString()); }),
    ] }) });
    editor.current = view;
    return () => { view.destroy(); editor.current = undefined; };
    // A workspace/file key remounts the editor; edits within a document preserve history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);
  return <div className="code-editor" ref={host} inert={disabled} />;
}
