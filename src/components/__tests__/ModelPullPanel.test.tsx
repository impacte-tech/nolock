import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModelPullPanel, { ModelPullJob } from "../ModelPullPanel";
import { mockInvoke } from "../../test/tauri-mock";

const job: ModelPullJob = { id: "abc", model: "owner/model:Q4_K_M", backend: "ollama", status: "downloading", message: "pulling layer", completed: 5, total: 10, created_at: 1, path: null };
beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async cmd => cmd === "list_model_pulls" ? [] : job);
});

describe("model pulls", () => {
  it("explains where to find the identifier and starts an Ollama pull using the current URL", async () => {
    render(<ModelPullPanel backend="ollama" url="http://ollama:11434" />);
    expect(screen.getByRole("link", { name: /Hugging Face GGUF/ })).toHaveAttribute("href", "https://huggingface.co/models?library=gguf");
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Hugging Face model identifier"), { target: { value: "owner/model:Q4_K_M" } });
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_model_pull", { req: { backend: "ollama", url: "http://ollama:11434", model: "owner/model:Q4_K_M", filename: "" } }));
    expect(await screen.findByRole("progressbar")).toHaveAttribute("value", "5");
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
  });

  it("forwards the optional llama.cpp GGUF filename", async () => {
    render(<ModelPullPanel backend="llamacpp" url="http://llamacpp:8080" />);
    fireEvent.change(screen.getByLabelText("Hugging Face model identifier"), { target: { value: "https://huggingface.co/owner/repo" } });
    fireEvent.change(screen.getByLabelText("GGUF filename"), { target: { value: "nested/model.gguf" } });
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("start_model_pull", { req: { backend: "llamacpp", url: "http://llamacpp:8080", model: "https://huggingface.co/owner/repo", filename: "nested/model.gguf" } }));
  });

  it("shows a pull error and allows another attempt", async () => {
    mockInvoke.mockImplementation(async cmd => { if (cmd === "start_model_pull") throw "Not enough free space"; return []; });
    render(<ModelPullPanel backend="ollama" url="http://ollama:11434" />);
    fireEvent.change(screen.getByLabelText("Hugging Face model identifier"), { target: { value: "owner/model" } });
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not enough free space");
    expect(screen.getByRole("button", { name: "Pull" })).toBeEnabled();
  });

  it("restores an active pull on reopening and can cancel it", async () => {
    mockInvoke.mockImplementation(async cmd => cmd === "list_model_pulls" ? [job] : { ...job, status: "cancelled", message: "Cancelled" });
    render(<ModelPullPanel backend="ollama" url="http://ollama:11434" />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel pull" }));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("cancel_model_pull", { req: { backend: "ollama", url: "http://ollama:11434", id: "abc" } });
  });

  it("discards late results after the provider changes", async () => {
    let resolve: (value: ModelPullJob) => void = () => {};
    mockInvoke.mockImplementation(async cmd => cmd === "start_model_pull" ? new Promise<ModelPullJob>(done => { resolve = done; }) : []);
    const view = render(<ModelPullPanel backend="ollama" url="http://ollama:11434" />);
    fireEvent.change(screen.getByLabelText("Hugging Face model identifier"), { target: { value: "owner/model" } });
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    view.rerender(<ModelPullPanel backend="llamacpp" url="http://llamacpp:8080" />);
    await act(async () => resolve(job));
    expect(screen.queryByText("pulling layer")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pull" })).toBeEnabled();
  });
});
