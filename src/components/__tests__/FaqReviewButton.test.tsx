import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FaqReviewButton from "../FaqReviewButton";
import { previewFaqReview, saveFaqReview } from "../../lib/faqReview";
vi.mock("../../lib/faqReview", async importOriginal => ({ ...await importOriginal<typeof import("../../lib/faqReview")>(), previewFaqReview: vi.fn(), saveFaqReview: vi.fn() }));
const props = { rootPath: "/project", question: "How does this work?", answer: "Original answer.", model: "model", backend: "ollama" };
beforeEach(() => { vi.mocked(previewFaqReview).mockReset().mockResolvedValue({ review: null, categories: ["Existing"] }); vi.mocked(saveFaqReview).mockReset().mockImplementation(async (_, review) => ({ ...review, revision: 1 })); });
async function open() { fireEvent.click(screen.getByRole("button", { name: "Review knowledge" })); await screen.findByLabelText("Chunk 1 text"); }
describe("knowledge review", () => {
  it("never writes on preview or cancel", async () => {
    render(<FaqReviewButton {...props}/>); await open();
    expect(saveFaqReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(saveFaqReview).not.toHaveBeenCalled();
  });
  it("requires acknowledgement for edited text and saves exactly approved content", async () => {
    render(<FaqReviewButton {...props}/>); await open();
    fireEvent.change(screen.getByLabelText("Chunk 1 text"), { target: { value: "Edited answer" } });
    fireEvent.change(screen.getByLabelText("Chunk 1 summary"), { target: { value: "My summary" } });
    fireEvent.change(screen.getByLabelText("Knowledge category"), { target: { value: "Existing" } });
    expect(screen.getByRole("button", { name: "Approve and save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Approve and save" }));
    await waitFor(() => expect(saveFaqReview).toHaveBeenCalledWith("/project", expect.objectContaining({ answer: props.answer, category: "Existing", chunks: [{ text: "Edited answer", summary: "My summary" }] })));
    await screen.findByRole("button", { name: "Review saved knowledge" });
  });
  it("retains the draft on failed embedding for retry", async () => {
    vi.mocked(saveFaqReview).mockRejectedValue(new Error("offline"));
    render(<FaqReviewButton {...props}/>); await open();
    fireEvent.click(screen.getByRole("button", { name: "Approve and save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing from this review was published");
    expect(screen.getByLabelText("Chunk 1 text")).toHaveValue(props.answer);
  });
  it("splits and merges without dropping source text", async () => {
    render(<FaqReviewButton {...props}/>); await open();
    fireEvent.click(screen.getByRole("button", { name: "Split in half" }));
    expect((screen.getByLabelText("Chunk 1 text") as HTMLTextAreaElement).value + (screen.getByLabelText("Chunk 2 text") as HTMLTextAreaElement).value).toBe(props.answer);
    fireEvent.click(screen.getAllByRole("button", { name: "Merge with next" })[0]);
    expect(screen.getByLabelText("Chunk 1 text")).toHaveValue(props.answer);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("reopens the approved draft and updates its revision instead of making a duplicate", async () => {
    const approved = { ...props, category: "Existing", chunks: [{ text: props.answer, summary: "Approved summary" }], revision: 3 };
    vi.mocked(previewFaqReview).mockResolvedValue({ review: approved, categories: ["Existing"] });
    render(<FaqReviewButton {...props}/>); await open();
    expect(screen.getByLabelText("Chunk 1 summary")).toHaveValue("Approved summary");
    fireEvent.click(screen.getByRole("button", { name: "Approve and update" }));
    await waitFor(() => expect(saveFaqReview).toHaveBeenCalledWith("/project", approved));
  });
  it("discards a late preview when the project changes", async () => {
    let finish!: (value: any) => void;
    vi.mocked(previewFaqReview).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<FaqReviewButton {...props}/>);
    fireEvent.click(screen.getByRole("button", { name: "Review knowledge" }));
    rerender(<FaqReviewButton {...props} rootPath="/other"/>);
    finish({ review: null, categories: [] });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(saveFaqReview).not.toHaveBeenCalled();
  });
});
