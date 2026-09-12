import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { getSecret } from "../lib/secrets";
import { getFimBackend, resolveBackendUrl } from "../lib/backends";
import { buildAiPrompt, processCompletionResponse } from "./fim";

// ---------------------------------------------------------------------------
// FIM Inline Completion Provider with gate-based debounce
//
// How it works:
//   - Every keystroke sets _ready = false (gate closed) and starts a timer
//   - After DEBOUNCE_MS of silence, timer fires → _ready = true (gate opens)
//   - Monaco calls provideInlineCompletions on many events (typing, cursor
//     moves, scroll, etc.) — but we only proceed when the gate is open.
//   - After one successful request the gate closes again until next pause.
//
// This guarantees exactly ONE request per typing pause, no matter how often
// Monaco calls us.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 500;

/** @internal exported for testing */
export class AiInlineCompletionProvider implements monaco.languages.InlineCompletionsProvider {
  private _requestCounter = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _editor: monaco.editor.IStandaloneCodeEditor | null = null;

  // Gate: only allow one request per debounce window
  private _ready = false;

  /** Set when user presses the explicit trigger shortcut (Ctrl+.) */
  private _explicitRequest = false;

  setEditor(editor: monaco.editor.IStandaloneCodeEditor) {
    this._editor = editor;
  }

  /** Called when user presses Ctrl+. — bypasses the debounce gate entirely */
  requestExplicitCompletion() {
    this._explicitRequest = true;
    this._ready = true;
    this._editor?.trigger("ai", "editor.action.inlineSuggest.trigger", null);
  }

  dispose() {
    ++this._requestCounter;
    this._ready = false;
    this._explicitRequest = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** Called on every content change — closes the gate and restarts the timer */
  onContentChange() {
    ++this._requestCounter;
    // Close the gate immediately
    this._ready = false;

    // Reset timer
    if (this._timer) {
      clearTimeout(this._timer);
    }

    this._timer = setTimeout(() => {
      this._timer = null;
      this._ready = true;

      // Ask Monaco to re-evaluate inline suggestions now that gate is open
      this._editor?.trigger("ai", "editor.action.inlineSuggest.trigger", null);
    }, DEBOUNCE_MS);
  }

  async provideInlineCompletions(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    _context: monaco.languages.InlineCompletionContext,
    token: monaco.CancellationToken
  ): Promise<monaco.languages.InlineCompletions> {
    // Providers are registered globally by Monaco; only serve our own editor.
    if (this._editor && (this._editor.getModel() !== model || !this._editor.hasTextFocus())) {
      return { items: [] };
    }
    // Explicit request (Ctrl+.) bypasses the gate check entirely
    const isExplicit = this._explicitRequest;
    this._explicitRequest = false;

    // Gate check — if not ready and not explicit, skip immediately
    if (!isExplicit && !this._ready) {
      return { items: [] };
    }

    // Consume the gate so we don't fire again until next pause
    this._ready = false;

    // --- Build prefix (code before cursor, last 4000 chars) ---
    const fullPrefix = model.getValueInRange({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });

    if (fullPrefix.trim().length < 5) {
      console.log("[FIM] prefix too short, skipping");
      return { items: [] };
    }

    const prefix = fullPrefix.length > 4000 ? fullPrefix.slice(-4000) : fullPrefix;

    // --- Build suffix (next 20 lines after cursor for FIM) ---
    const totalLines = model.getLineCount();
    const suffixEndLine = Math.min(position.lineNumber + 20, totalLines);
    const suffix = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: suffixEndLine,
      endColumn: model.getLineMaxColumn(suffixEndLine),
    });

    const requestId = ++this._requestCounter;

    try {
      const backend = getFimBackend();
      const url = resolveBackendUrl(backend);
      const completionModel = localStorage.getItem("nolock.completionModel") || "";
      const apiKey = (await getSecret(`apiKey.${backend}`)) ?? localStorage.getItem(`nolock.apiKey.${backend}`) ?? "";

      const fitmTemperature = localStorage.getItem("nolock.fitmTemperature");
      const fitmMaxTokens = localStorage.getItem("nolock.fitmMaxTokens");

      if (!completionModel) {
        console.log("[FIM] no completion model configured");
        return { items: [] };
      }

      const hasSuffix = !!(suffix && suffix.trim().length > 0);

      let currentPrompt = buildAiPrompt(prefix, suffix || null);

      console.log("[FIM] prefix_last_100:", JSON.stringify(prefix.slice(-100)));
      console.log("[FIM] suffix_first_100:", JSON.stringify(suffix.slice(0, 100)));
      console.log("[FIM] hasSuffix:", hasSuffix);
      console.log("[FIM] prompt_len:", currentPrompt.length);
      console.log("[FIM] prompt_starts_with_FIM:", currentPrompt.startsWith("<|fim_prefix|>"));

      const attemptCompletion = async (
        prompt: string,
        attemptSuffix: string | null,
      ): Promise<string> => {
        return invoke("ai_complete", {
          req: {
            backend,
            url,
            model: completionModel,
            prompt,
            suffix: attemptSuffix,
            apiKey: apiKey || null,
            temperature: fitmTemperature ? parseFloat(fitmTemperature) : undefined,
            max_tokens: fitmMaxTokens ? parseInt(fitmMaxTokens, 10) : undefined,
          },
        });
      };

      console.log("[FIM] --- attempt 1 (FIM) ---");
      let text: string = await attemptCompletion(currentPrompt, hasSuffix ? suffix : null);
      console.log("[FIM] attempt 1 raw response:", JSON.stringify(text));
      console.log("[FIM] attempt 1 response_len:", text.length);

      if (token.isCancellationRequested || requestId !== this._requestCounter) {
        console.log("[FIM] discard stale response (attempt 1)");
        return { items: [] };
      }

      if (!text && hasSuffix) {
        console.log("[FIM] FIM returned empty, retrying with raw prefix");
        currentPrompt = prefix;
        console.log("[FIM] --- attempt 2 (raw prefix, no FIM) ---");
        text = await attemptCompletion(currentPrompt, null);
        console.log("[FIM] attempt 2 raw response:", JSON.stringify(text));
        console.log("[FIM] attempt 2 response_len:", text.length);

        if (token.isCancellationRequested || requestId !== this._requestCounter) {
          console.log("[FIM] discard stale response (attempt 2)");
          return { items: [] };
        }
      }

      if (!text) {
        console.log("[FIM] all attempts returned empty, no suggestion");
        return { items: [] };
      }

      const cleaned = processCompletionResponse(text);
      console.log("[FIM] cleaned:", JSON.stringify(cleaned));

      if (!cleaned) {
        console.log("[FIM] cleaning pipeline rejected the response");
        return { items: [] };
      }

      console.log("[FIM] returning suggestion, len:", cleaned.length);
      return {
        items: [
          {
            insertText: cleaned,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            ),
          },
        ],
      };
    } catch (err) {
      console.log("[FIM] error:", err);
      return { items: [] };
    }
  }

  freeInlineCompletions(): void {}
}
