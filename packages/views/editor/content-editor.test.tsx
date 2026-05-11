import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const mockFocus = vi.hoisted(() => vi.fn());
const mockSetContent = vi.hoisted(() => vi.fn());
const mockSetTextSelection = vi.hoisted(() => vi.fn());
const editorState = vi.hoisted(() => ({
  isFocused: false,
  isDestroyed: false,
  markdown: "",
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({}),
}));

vi.mock("./extensions", () => ({
  createEditorExtensions: () => [],
}));

vi.mock("./extensions/file-upload", () => ({
  uploadAndInsertFile: vi.fn(),
}));

vi.mock("./utils/preprocess", () => ({
  preprocessMarkdown: (value: string) => value,
}));

vi.mock("./bubble-menu", () => ({
  EditorBubbleMenu: () => null,
}));

const editorRef = vi.hoisted<{ current: unknown }>(() => ({ current: null }));
const onCreateFired = vi.hoisted(() => ({ value: false }));
const capturedHandlers = vi.hoisted<{
  onFocus?: (args: { editor: unknown }) => void;
  onBlur?: (args: { editor: unknown }) => void;
}>(() => ({}));

vi.mock("@tiptap/react", () => ({
  useEditor: (options: {
    onCreate?: (args: { editor: unknown }) => void;
    onFocus?: (args: { editor: unknown }) => void;
    onBlur?: (args: { editor: unknown }) => void;
  }) => {
    if (!editorRef.current) {
      editorRef.current = {
        get isFocused() {
          return editorState.isFocused;
        },
        get isDestroyed() {
          return editorState.isDestroyed;
        },
        commands: {
          focus: mockFocus,
          clearContent: vi.fn(),
          setContent: mockSetContent,
          setTextSelection: mockSetTextSelection,
        },
        getMarkdown: () => editorState.markdown,
        state: {
          doc: { content: { size: 0 } },
          selection: { empty: true, from: 0, to: 0 },
        },
      };
    }
    capturedHandlers.onFocus = options?.onFocus;
    capturedHandlers.onBlur = options?.onBlur;
    if (!onCreateFired.value) {
      onCreateFired.value = true;
      options?.onCreate?.({ editor: editorRef.current });
    }
    return editorRef.current;
  },
  EditorContent: ({ className }: { className?: string }) => (
    <div className={className} data-testid="editor-content">
      <div className="ProseMirror rich-text-editor" data-testid="prosemirror" />
    </div>
  ),
}));

function fireFocus() {
  capturedHandlers.onFocus?.({ editor: editorRef.current });
}

function fireBlur() {
  capturedHandlers.onBlur?.({ editor: editorRef.current });
}

import { ContentEditor } from "./content-editor";

describe("ContentEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorState.isFocused = false;
    editorState.isDestroyed = false;
    editorState.markdown = "";
    editorRef.current = null;
    onCreateFired.value = false;
    capturedHandlers.onFocus = undefined;
    capturedHandlers.onBlur = undefined;
  });

  it("focuses the editor when clicking the empty container area", () => {
    render(<ContentEditor placeholder="Add description..." />);

    const shell = screen.getByTestId("editor-content").parentElement;
    expect(shell).not.toBeNull();

    fireEvent.mouseDown(shell!);

    expect(mockFocus).toHaveBeenCalledWith("end");
  });

  it("does not hijack clicks that land inside the ProseMirror node", () => {
    render(<ContentEditor placeholder="Add description..." />);

    fireEvent.mouseDown(screen.getByTestId("prosemirror"));

    expect(mockFocus).not.toHaveBeenCalled();
  });

  it("syncs editor content when defaultValue changes externally and editor is unfocused", () => {
    editorState.markdown = "old content";
    const { rerender } = render(<ContentEditor defaultValue="old content" />);

    expect(mockSetContent).not.toHaveBeenCalled();

    editorState.markdown = "old content"; // editor still holds old content
    rerender(<ContentEditor defaultValue="new content from server" />);

    expect(mockSetContent).toHaveBeenCalledTimes(1);
    expect(mockSetContent).toHaveBeenCalledWith(
      "new content from server",
      expect.objectContaining({ emitUpdate: false, contentType: "markdown" }),
    );
  });

  it("does not sync when editor is currently focused (user is typing)", () => {
    editorState.markdown = "old content";
    const { rerender } = render(<ContentEditor defaultValue="old content" />);

    editorState.isFocused = true;
    editorState.markdown = "user-typed-content";
    rerender(<ContentEditor defaultValue="incoming external change" />);

    expect(mockSetContent).not.toHaveBeenCalled();
  });

  it("does not sync when defaultValue equals current editor markdown", () => {
    editorState.markdown = "same content";
    const { rerender } = render(<ContentEditor defaultValue="same content" />);

    rerender(<ContentEditor defaultValue="same content" />);

    expect(mockSetContent).not.toHaveBeenCalled();
  });

  it("on blur with no external change, does not invoke onExternalConflict", async () => {
    const onExternalConflict = vi.fn();
    editorState.markdown = "stable content";

    render(
      <ContentEditor
        defaultValue="stable content"
        onUpdate={() => {}}
        onExternalConflict={onExternalConflict}
      />,
    );

    fireFocus();
    // User types something, but external value is unchanged.
    editorState.markdown = "user typed";
    fireBlur();

    await Promise.resolve();
    expect(onExternalConflict).not.toHaveBeenCalled();
  });

  it("on blur with external change but no local edits, applies external silently", async () => {
    const onExternalConflict = vi.fn();
    editorState.markdown = "old";

    const { rerender } = render(
      <ContentEditor
        defaultValue="old"
        onUpdate={() => {}}
        onExternalConflict={onExternalConflict}
      />,
    );

    fireFocus();
    editorState.isFocused = true;
    // External update arrives mid-edit (existing dirty-guard effect skips
    // because the editor is focused).
    rerender(
      <ContentEditor
        defaultValue="external change"
        onUpdate={() => {}}
        onExternalConflict={onExternalConflict}
      />,
    );
    // User didn't type — editor markdown still matches baseline.
    editorState.isFocused = false;
    fireBlur();

    await Promise.resolve();
    expect(onExternalConflict).not.toHaveBeenCalled();
    expect(mockSetContent).toHaveBeenCalledWith(
      "external change",
      expect.objectContaining({ emitUpdate: false, contentType: "markdown" }),
    );
  });

  it("on blur with conflict, invokes onExternalConflict with local/external/baseline", async () => {
    const onExternalConflict = vi
      .fn()
      .mockResolvedValue({ type: "local" });
    editorState.markdown = "baseline";

    const { rerender } = render(
      <ContentEditor
        defaultValue="baseline"
        onUpdate={() => {}}
        onExternalConflict={onExternalConflict}
      />,
    );

    fireFocus();
    editorState.isFocused = true;
    rerender(
      <ContentEditor
        defaultValue="external change"
        onUpdate={() => {}}
        onExternalConflict={onExternalConflict}
      />,
    );
    editorState.markdown = "user typed";
    editorState.isFocused = false;
    fireBlur();

    await Promise.resolve();
    await Promise.resolve();
    expect(onExternalConflict).toHaveBeenCalledWith({
      local: "user typed",
      external: "external change",
      baseline: "baseline",
    });
  });

  it("resolution=local: leaves editor content and does not call setContent", async () => {
    const onExternalConflict = vi
      .fn()
      .mockResolvedValue({ type: "local" });
    editorState.markdown = "baseline";

    const { rerender } = render(
      <ContentEditor
        defaultValue="baseline"
        onUpdate={() => {}}
        onExternalConflict={onExternalConflict}
      />,
    );

    fireFocus();
    editorState.isFocused = true;
    rerender(
      <ContentEditor
        defaultValue="external"
        onUpdate={() => {}}
        onExternalConflict={onExternalConflict}
      />,
    );
    editorState.markdown = "user typed";
    editorState.isFocused = false;
    fireBlur();

    await Promise.resolve();
    await Promise.resolve();
    expect(mockSetContent).not.toHaveBeenCalled();
  });

  it("resolution=external: setContent with external, no onUpdate emit", async () => {
    const onUpdate = vi.fn();
    const onExternalConflict = vi
      .fn()
      .mockResolvedValue({ type: "external" });
    editorState.markdown = "baseline";

    const { rerender } = render(
      <ContentEditor
        defaultValue="baseline"
        onUpdate={onUpdate}
        onExternalConflict={onExternalConflict}
      />,
    );

    fireFocus();
    editorState.isFocused = true;
    rerender(
      <ContentEditor
        defaultValue="external value"
        onUpdate={onUpdate}
        onExternalConflict={onExternalConflict}
      />,
    );
    editorState.markdown = "user typed";
    editorState.isFocused = false;
    fireBlur();

    await Promise.resolve();
    await Promise.resolve();
    expect(mockSetContent).toHaveBeenCalledWith(
      "external value",
      expect.objectContaining({ emitUpdate: false, contentType: "markdown" }),
    );
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("resolution=merged: setContent with merged + onUpdate fires with merged content", async () => {
    const onUpdate = vi.fn();
    const onExternalConflict = vi
      .fn()
      .mockResolvedValue({ type: "merged", content: "merged result" });
    editorState.markdown = "baseline";

    const { rerender } = render(
      <ContentEditor
        defaultValue="baseline"
        onUpdate={onUpdate}
        onExternalConflict={onExternalConflict}
      />,
    );

    fireFocus();
    editorState.isFocused = true;
    rerender(
      <ContentEditor
        defaultValue="external value"
        onUpdate={onUpdate}
        onExternalConflict={onExternalConflict}
      />,
    );
    editorState.markdown = "user typed";
    editorState.isFocused = false;
    fireBlur();

    // setContent in real Tiptap mutates editor markdown; mock it.
    editorState.markdown = "merged result";

    await Promise.resolve();
    await Promise.resolve();
    expect(mockSetContent).toHaveBeenCalledWith(
      "merged result",
      expect.objectContaining({ emitUpdate: false, contentType: "markdown" }),
    );
    expect(onUpdate).toHaveBeenCalledWith("merged result");
  });

  it("does not sync when editor is unfocused but has unsaved local edits", () => {
    // Initial render: editor seeded with "old content". onCreate fires and
    // sets lastEmittedRef = "old content". User then types — editor markdown
    // diverges from lastEmittedRef but the debounce hasn't fired yet, so
    // onUpdate hasn't been called and `lastEmittedRef` still holds the old
    // value. User blurs (so isFocused=false). External update arrives.
    // We must NOT clobber the unsaved local edits.
    editorState.markdown = "old content";
    const { rerender } = render(
      <ContentEditor defaultValue="old content" onUpdate={() => {}} />,
    );

    // User typed locally, then blurred. Debounce hasn't flushed yet so
    // lastEmittedRef inside the component still reflects "old content".
    editorState.isFocused = false;
    editorState.markdown = "user typed but unsaved";

    rerender(
      <ContentEditor
        defaultValue="external update from another agent"
        onUpdate={() => {}}
      />,
    );

    expect(mockSetContent).not.toHaveBeenCalled();
  });
});
