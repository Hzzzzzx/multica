"use client";

/**
 * ContentEditor — the rich-text editor used wherever the user TYPES content.
 *
 * Architecture decisions (April 2026 refactor):
 *
 * 1. EDITING ONLY. Read-only display is handled by `ReadonlyContent` (a
 *    react-markdown renderer), not this component. There used to be an
 *    `editable` prop here that toggled between modes, but every readonly
 *    callsite migrated to ReadonlyContent and the prop only invited
 *    misuse — Tiptap's `useEditor` reads `editable` at mount, so toggling
 *    the prop later silently failed (mounted-as-readonly editors stayed
 *    unfocusable forever). To express "currently disabled", wrap this
 *    component in a layout that sets `pointer-events-none` / `aria-disabled`
 *    — don't reach into the editor.
 *
 * 2. ONE MARKDOWN PIPELINE via @tiptap/markdown. Content is loaded with
 *    `contentType: 'markdown'` and saved with `editor.getMarkdown()`.
 *    Previously we had a custom `markdownToHtml()` pipeline (Marked library)
 *    for loading and regex post-processing for saving — two asymmetric paths
 *    that caused roundtrip inconsistencies. The @tiptap/markdown extension
 *    (v3.21.0+) handles table cell <p> wrapping and custom mention tokenizers
 *    natively, eliminating the need for the HTML detour.
 *
 * 3. PREPROCESSING is minimal: only legacy mention shortcode migration and
 *    URL linkification (preprocessMarkdown). No HTML conversion.
 *
 * Tech: Tiptap v3.22.1 (ProseMirror wrapper), @tiptap/markdown for
 * bidirectional Markdown ↔ ProseMirror JSON conversion.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { cn } from "@multica/ui/lib/utils";
import type { UploadResult } from "@multica/core/hooks/use-file-upload";
import { useWorkspaceSlug } from "@multica/core/paths";
import { useQueryClient } from "@tanstack/react-query";
import { createEditorExtensions } from "./extensions";
import { uploadAndInsertFile } from "./extensions/file-upload";
import { preprocessMarkdown } from "./utils/preprocess";
import { openLink, isMentionHref } from "./utils/link-handler";
import { EditorBubbleMenu } from "./bubble-menu";
import { useLinkHover, LinkHoverCard } from "./link-hover-card";
import "katex/dist/katex.min.css";
import "./content-editor.css";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Blob URLs (blob:http://…) are process-local and expire on reload. Strip them
 *  from serialised markdown so they never reach the database. */
const BLOB_IMAGE_RE = /!\[[^\]]*\]\(blob:[^)]*\)\n?/g;

function stripBlobUrls(md: string): string {
  return md.replace(BLOB_IMAGE_RE, "");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Resolution returned by `onExternalConflict` to tell ContentEditor how to
 * reconcile a conflict that occurred while the user was focus-editing.
 *
 * - "local": keep what the user typed; the existing onUpdate path will persist
 *   it to the server (last-write-wins on this side).
 * - "external": discard the user's edits and apply the external content.
 * - "merged": apply the user-authored merged content AND emit it to onUpdate
 *   so the merged version is persisted server-side.
 */
export type ContentEditorResolution =
  | { type: "local" }
  | { type: "external" }
  | { type: "merged"; content: string };

interface ContentEditorProps {
  defaultValue?: string;
  onUpdate?: (markdown: string) => void;
  placeholder?: string;
  className?: string;
  debounceMs?: number;
  onSubmit?: () => void;
  onBlur?: () => void;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  /**
   * Called on blur when the external `defaultValue` has changed during the
   * user's focus session AND the user has made local edits that diverge.
   * The implementor typically opens a conflict dialog and returns the user's
   * choice. If undefined or the returned resolution is `{ type: "local" }`,
   * ContentEditor takes no further action and the existing onUpdate path
   * persists the local edits.
   */
  onExternalConflict?: (params: {
    local: string;
    external: string;
    baseline: string;
  }) => Promise<ContentEditorResolution>;
  /** Show the floating formatting toolbar on text selection. Defaults true. */
  showBubbleMenu?: boolean;
  /** When true, bare Enter submits (chat-style). Mod-Enter always submits. */
  submitOnEnter?: boolean;
  /**
   * ID of the issue this editor belongs to. When set, the bubble menu exposes
   * a "Create sub-issue from selection" action that parents the new issue
   * under this ID and replaces the selection with a mention link.
   */
  currentIssueId?: string;
  /**
   * When true, the @mention extension is not registered. Use for editors
   * where mentioning members/agents has no business meaning (e.g. agent
   * system prompts, where the content is fed to an LLM as plain text).
   */
  disableMentions?: boolean;
}

interface ContentEditorRef {
  getMarkdown: () => string;
  clearContent: () => void;
  focus: () => void;
  /** Drop focus from the editor — used by chat after send so the caret
   *  stops competing with the StatusPill / streaming reply for the user's
   *  attention. */
  blur: () => void;
  uploadFile: (file: File) => void;
  /** True when file uploads are still in progress. */
  hasActiveUploads: () => boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ContentEditor = forwardRef<ContentEditorRef, ContentEditorProps>(
  function ContentEditor(
    {
      defaultValue = "",
      onUpdate,
      placeholder: placeholderText = "",
      className,
      debounceMs = 300,
      onSubmit,
      onBlur,
      onUploadFile,
      onExternalConflict,
      showBubbleMenu = true,
      submitOnEnter = false,
      currentIssueId,
      disableMentions = false,
    },
    ref,
  ) {
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const onUpdateRef = useRef(onUpdate);
    const onSubmitRef = useRef(onSubmit);
    const onBlurRef = useRef(onBlur);
    const onUploadFileRef = useRef(onUploadFile);
    const onExternalConflictRef = useRef(onExternalConflict);
    const defaultValueRef = useRef(defaultValue);
    const lastEmittedRef = useRef<string | null>(null);
    // Captures the external value at focus-start so we can detect "external
    // changed during this focus session". Set in onFocus, consumed (and
    // cleared) in onBlur.
    const focusBaselineRef = useRef<string | null>(null);

    // Current workspace slug kept in a ref so the click handler always sees the
    // latest value without recreating the editor. Used by openLink to prefix
    // legacy /issues/... style paths that lack a workspace slug.
    const workspaceSlug = useWorkspaceSlug();
    const workspaceSlugRef = useRef(workspaceSlug);
    workspaceSlugRef.current = workspaceSlug;

    // Keep refs in sync without recreating editor
    onUpdateRef.current = onUpdate;
    onSubmitRef.current = onSubmit;
    onBlurRef.current = onBlur;
    onUploadFileRef.current = onUploadFile;
    onExternalConflictRef.current = onExternalConflict;
    defaultValueRef.current = defaultValue;

    const queryClient = useQueryClient();

    // Apply a conflict resolution by mutating the editor and bookkeeping refs.
    // - "local": no-op; the existing onUpdate debounce will persist local edits.
    // - "external"/"merged": cancel any pending local save, replace content
    //   with `emitUpdate: false` (so we don't re-fire onUpdate), and update
    //   `lastEmittedRef` so the next typed character is detected as dirty.
    //   "merged" additionally emits onUpdate so the merged version is saved.
    function applyResolution(
      ed: Editor,
      r: ContentEditorResolution,
      externalSnapshot: string,
    ) {
      if (r.type === "local") return;

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }

      const newContent =
        r.type === "external" ? externalSnapshot : r.content;
      ed.commands.setContent(newContent, {
        emitUpdate: false,
        contentType: "markdown",
      });
      lastEmittedRef.current = stripBlobUrls(ed.getMarkdown()).trimEnd();

      if (r.type === "merged") {
        onUpdateRef.current?.(lastEmittedRef.current);
      }
    }

    // On blur, decide whether an external update arrived during this focus
    // session and, if so, whether it conflicts with local edits.
    //
    //   external === baseline → no external change happened; nothing to do.
    //   local === baseline    → user didn't type; apply external silently.
    //   local === external    → user happened to converge on external; no-op.
    //   otherwise             → real conflict; defer to onExternalConflict.
    async function handleBlurConflict(ed: Editor) {
      const baseline = focusBaselineRef.current;
      focusBaselineRef.current = null;
      if (baseline === null) return;

      const local = stripBlobUrls(ed.getMarkdown()).trimEnd();
      const external = stripBlobUrls(
        preprocessMarkdown(defaultValueRef.current ?? ""),
      ).trimEnd();

      if (external === baseline) return;
      if (local === baseline) {
        applyResolution(ed, { type: "external" }, external);
        return;
      }
      if (local === external) return;

      const resolver = onExternalConflictRef.current;
      if (!resolver) return;
      const resolution = await resolver({ local, external, baseline });
      applyResolution(ed, resolution, external);
    }

    const editor = useEditor({
      immediatelyRender: false,
      // Note: in v3.22.1 the default is already false/undefined (same behavior).
      // Explicit for clarity — the real perf win is useEditorState in BubbleMenu.
      shouldRerenderOnTransaction: false,
      onCreate: ({ editor: ed }) => {
        lastEmittedRef.current = stripBlobUrls(ed.getMarkdown()).trimEnd();
      },
      content: defaultValue ? preprocessMarkdown(defaultValue) : "",
      contentType: defaultValue ? "markdown" : undefined,
      extensions: createEditorExtensions({
        placeholder: placeholderText,
        queryClient,
        onSubmitRef,
        onUploadFileRef,
        submitOnEnter,
        disableMentions,
      }),
      onUpdate: ({ editor: ed }) => {
        if (!onUpdateRef.current) return;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          const md = stripBlobUrls(ed.getMarkdown()).trimEnd();
          if (md === lastEmittedRef.current) return;
          lastEmittedRef.current = md;
          onUpdateRef.current?.(md);
        }, debounceMs);
      },
      onFocus: () => {
        focusBaselineRef.current = stripBlobUrls(
          preprocessMarkdown(defaultValueRef.current ?? ""),
        ).trimEnd();
      },
      onBlur: ({ editor: ed }) => {
        void handleBlurConflict(ed);
        onBlurRef.current?.();
      },
      editorProps: {
        handleDOMEvents: {
          click(_view, event) {
            const target = event.target as HTMLElement;
            // Skip links inside NodeView wrappers — they handle their own clicks
            if (target.closest("[data-node-view-wrapper]")) return false;

            const link = target.closest("a");
            const href = link?.getAttribute("href");
            if (!href || isMentionHref(href)) return false;

            event.preventDefault();
            openLink(href, workspaceSlugRef.current);
            return true;
          },
        },
        attributes: {
          class: cn("rich-text-editor text-sm outline-none", className),
        },
      },
    });

    // Cleanup debounce on unmount
    useEffect(() => {
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }, []);

    // Sync external `defaultValue` changes into the editor.
    //
    // Tiptap's `useEditor` reads `content` only at mount; later prop updates
    // are silently ignored ([ueberdosis/tiptap#5831]). When a WS event or
    // another client updates `issue.description`, the TanStack Query cache
    // produces a new prop here — without this effect the editor keeps showing
    // stale content until the consumer remounts (`key={id}` only fires on
    // issue switch, not on same-issue updates).
    //
    // Guards (in order):
    //   1. Skip when the editor is focused — the user is typing locally and
    //      clobbering their input would lose the caret + in-flight characters.
    //   2. Skip when the editor has unsaved local edits (dirty). `isFocused`
    //      is not enough: after blur, there's a window before the `onUpdate`
    //      debounce fires where the editor's markdown diverges from what's
    //      been emitted to the parent. `lastEmittedRef.current` is updated
    //      only inside `onCreate` and after the debounce flushes, so a
    //      mismatch with the current editor markdown means there's unsaved
    //      local content we must not clobber.
    //   3. Skip when the incoming markdown matches what the editor already
    //      holds — avoids a no-op transaction when the cache reflects a write
    //      this same editor just emitted via `onUpdate`.
    //   4. Pass `emitUpdate: false` so the synced write does not re-trigger
    //      `onUpdate` → `onUpdateRef` → server save (self-write loop).
    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      if (editor.isFocused) return;

      const current = stripBlobUrls(editor.getMarkdown()).trimEnd();
      if (
        lastEmittedRef.current !== null &&
        current !== lastEmittedRef.current
      ) {
        return;
      }

      const incoming = defaultValue ? preprocessMarkdown(defaultValue) : "";
      const incomingNormalized = stripBlobUrls(incoming).trimEnd();
      if (incomingNormalized === current) return;

      const { from, to } = editor.state.selection;
      editor.commands.setContent(incoming, {
        emitUpdate: false,
        contentType: "markdown",
      });

      const docSize = editor.state.doc.content.size;
      const clampedFrom = Math.min(from, docSize);
      const clampedTo = Math.min(to, docSize);
      editor.commands.setTextSelection({ from: clampedFrom, to: clampedTo });

      lastEmittedRef.current = stripBlobUrls(editor.getMarkdown()).trimEnd();
    }, [defaultValue, editor]);

    useImperativeHandle(ref, () => ({
      getMarkdown: () => stripBlobUrls(editor?.getMarkdown() ?? ""),
      clearContent: () => {
        editor?.commands.clearContent();
      },
      focus: () => {
        editor?.commands.focus();
      },
      blur: () => {
        editor?.commands.blur();
      },
      uploadFile: (file: File) => {
        if (!editor || !onUploadFileRef.current) return;
        const endPos = editor.state.doc.content.size;
        uploadAndInsertFile(editor, file, onUploadFileRef.current, endPos);
      },
      hasActiveUploads: () => {
        if (!editor) return false;
        let uploading = false;
        editor.state.doc.descendants((node) => {
          if (node.attrs.uploading) uploading = true;
          return !uploading;
        });
        return uploading;
      },
    }));

    // Link hover card — disabled when BubbleMenu is active (has selection)
    const wrapperRef = useRef<HTMLDivElement>(null);
    const hoverDisabled = !editor?.state.selection.empty;
    const hover = useLinkHover(wrapperRef, hoverDisabled);

    const handleContainerMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!editor) return;

      const target = event.target as HTMLElement;
      if (target.closest(".ProseMirror")) return;
      if (target.closest("a, button, input, textarea, [role='button'], [data-node-view-wrapper]")) return;

      event.preventDefault();
      editor.commands.focus("end");
    };

    if (!editor) return null;

    return (
      <div
        ref={wrapperRef}
        className="relative flex min-h-full flex-col"
        onMouseDown={handleContainerMouseDown}
      >
        <EditorContent className="flex-1 min-h-full" editor={editor} />
        {showBubbleMenu && (
          <EditorBubbleMenu editor={editor} currentIssueId={currentIssueId} />
        )}
        <LinkHoverCard {...hover} />
      </div>
    );
  },
);

export { ContentEditor, type ContentEditorProps, type ContentEditorRef };
