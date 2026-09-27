import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { previewFaqReview, saveFaqReview, splitReviewText, type FaqReview } from "../lib/faqReview";

interface Props { rootPath: string; question: string; answer: string; model: string; backend: string }
export default function FaqReviewButton({ rootPath, question, answer, model, backend }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FaqReview | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [size, setSize] = useState(2000);
  const [acknowledged, setAcknowledged] = useState(false);
  const epoch = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const book = useRef<HTMLButtonElement>(null);
  useEffect(() => { ++epoch.current; setOpen(false); setDraft(null); setSaved(false); setBusy(false); return () => { ++epoch.current; }; }, [rootPath, question, answer]);
  useEffect(() => { if (open) dialog.current?.focus(); }, [open]);
  const close = () => { if (!busy) { ++epoch.current; setOpen(false); book.current?.focus(); } };
  const begin = async () => {
    const current = ++epoch.current;
    setOpen(true); setBusy(true); setError(""); setAcknowledged(false); setDraft(null);
    try {
      const preview = await previewFaqReview(rootPath, question, answer);
      if (epoch.current !== current) return;
      setCategories(preview.categories);
      setSaved(!!preview.review);
      setDraft(preview.review ?? { question, answer, model, backend, revision: 0,
        category: question.trim().split(/\n/)[0].slice(0, 80) || "Learning", chunks: splitReviewText(answer, size) });
    } catch (e) { if (epoch.current === current) setError(`Could not load review: ${String(e)}`); }
    finally { if (epoch.current === current) setBusy(false); }
  };
  const changed = !!draft && draft.chunks.map(c => c.text).join("") !== answer;
  const edit = (next: FaqReview) => { setDraft(next); setAcknowledged(false); };
  const approve = async () => {
    if (!draft || busy || (changed && !acknowledged)) return;
    const current = epoch.current;
    setBusy(true); setError("");
    try {
      const result = await saveFaqReview(rootPath, draft);
      if (epoch.current !== current) return;
      setDraft(result); setSaved(true); setOpen(false); book.current?.focus();
    } catch (e) { if (epoch.current === current) setError(`Nothing from this review was published. ${String(e)} You can retry approval.`); }
    finally { if (epoch.current === current) setBusy(false); }
  };
  return <>
    <button ref={book} className="rlhf-btn" disabled={!rootPath || !question.trim()} onClick={() => void begin()} aria-label={saved ? "Review saved knowledge" : "Review knowledge"} title={rootPath ? (saved ? "Saved to knowledge base — review" : "Review and save to knowledge base") : "Open a project to save knowledge"}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5C8 3 4 3 2 4v15c3-1 6-1 10 1 4-2 7-2 10-1V4c-2-1-6-1-10 1Zm0 0v15"/></svg>{saved && <span aria-hidden="true">✓</span>}
    </button>
    {open && createPortal(<div className="modal-overlay faq-review-overlay" onClick={close}>
      <div ref={dialog} className="modal faq-review" role="dialog" aria-modal="true" aria-label="Review knowledge" tabIndex={-1} onClick={e => e.stopPropagation()} onKeyDown={e => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); close(); }
        if (e.key === "Tab") {
          const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary')).filter(el => el.getClientRects().length);
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
        <div className="modal-header"><strong>Review knowledge</strong><button disabled={busy} onClick={close} aria-label="Close knowledge review">×</button></div>
        <div className="modal-body">
          <p>Review the passages, summary excerpts and category before saving. Originals are preserved separately. Only approved content becomes searchable.</p>
          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">{draft ? "Embedding approved content…" : "Loading review…"}</p>}
          {draft && <fieldset disabled={busy}>
            <details><summary>Original question and answer (preserved unchanged)</summary><h4>Question</h4><pre>{question}</pre><h4>Answer</h4><pre>{answer}</pre></details>
            <label>Category<input aria-label="Knowledge category" list="faq-review-categories" maxLength={100} value={draft.category} onChange={e => edit({ ...draft, category: e.target.value })}/></label>
            <datalist id="faq-review-categories">{categories.map(c => <option key={c} value={c}/>)}</datalist>
            <p>{categories.includes(draft.category.trim()) ? "Uses this existing category." : `Creates category “${draft.category.trim()}” when approved.`}</p>
            <label>Maximum characters per proposed chunk<input aria-label="Chunk size" type="number" min={100} max={8000} value={size} onChange={e => setSize(Number(e.target.value))}/></label>
            <p>Paragraph-first splitting; counts Unicode characters, not model tokens. Summary suggestions are editable excerpts, not generated summaries. Oversized code blocks may span chunks.</p>
            <button type="button" onClick={() => edit({ ...draft, chunks: splitReviewText(answer, size) })}>Reset chunks from original</button>
            <p role="status">{changed ? "Reviewed text differs from the original: passages may be edited, omitted, duplicated or reordered. Compare the original before approval." : "All original answer text is included, in order."}</p>
            {draft.chunks.map((chunk, i) => <section className="faq-review-chunk" key={i}>
              <h4>Chunk {i + 1}</h4>
              <label>Passage<textarea aria-label={`Chunk ${i + 1} text`} rows={7} value={chunk.text} onChange={e => edit({ ...draft, chunks: draft.chunks.map((c, n) => n === i ? { ...c, text: e.target.value } : c) })}/></label>
              <label>Summary<textarea aria-label={`Chunk ${i + 1} summary`} rows={2} value={chunk.summary} onChange={e => edit({ ...draft, chunks: draft.chunks.map((c, n) => n === i ? { ...c, summary: e.target.value } : c) })}/></label>
              <div className="faq-review-controls">
                <button type="button" disabled={Array.from(chunk.text).length < 2} onClick={() => { const chars = Array.from(chunk.text); const mid = Math.ceil(chars.length / 2); const chunks = [...draft.chunks]; chunks.splice(i, 1, { text: chars.slice(0, mid).join(""), summary: chunk.summary }, { text: chars.slice(mid).join(""), summary: "" }); edit({ ...draft, chunks }); }}>Split in half</button>
                <button type="button" disabled={i === draft.chunks.length - 1} onClick={() => { const chunks = [...draft.chunks]; const next = chunks[i + 1]; chunks.splice(i, 2, { text: chunk.text + next.text, summary: [chunk.summary, next.summary].filter(Boolean).join("\n") }); edit({ ...draft, chunks }); }}>Merge with next</button>
                <button type="button" disabled={i === 0} onClick={() => { const chunks = [...draft.chunks]; [chunks[i - 1], chunks[i]] = [chunks[i], chunks[i - 1]]; edit({ ...draft, chunks }); }}>Move up</button>
                <button type="button" onClick={() => edit({ ...draft, chunks: draft.chunks.filter((_, n) => n !== i) })}>Remove chunk</button>
              </div>
            </section>)}
            {changed && <label><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)}/>I approve the changes to the reviewed text; the original will remain preserved.</label>}
            <p>The embedding provider configured for chat receives the question, approved passages and summaries only after approval.</p>
          </fieldset>}
        </div>
        <div className="modal-footer"><button disabled={busy} onClick={close}>Cancel</button><button className="btn-primary" disabled={busy || !draft || !draft.category.trim() || !draft.chunks.length || draft.chunks.some(c => !c.text.trim()) || (changed && !acknowledged)} onClick={() => void approve()}>{busy && draft ? "Embedding…" : saved ? "Approve and update" : "Approve and save"}</button></div>
      </div>
    </div>, document.body)}
  </>;
}
