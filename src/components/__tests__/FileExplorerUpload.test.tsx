import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FileExplorer from "../FileExplorer";
import { mockInvoke } from "../../test/tauri-mock";
import { MAX_UPLOAD_BYTES } from "../../lib/uploads";

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async (cmd: string) => cmd === "list_directory" ? [{ name: "folder", path: "/project/folder", is_dir: true }] : "/project/data.bin");
});
const mount = () => render(<FileExplorer rootPath="/project" setRootPath={vi.fn()} onFileOpen={vi.fn()} visible />);

describe("file uploads", () => {
  it("uploads binary bytes through the picker and reports success", async () => {
    mount();
    const file = new File([new Uint8Array([0, 255, 128])], "data.bin");
    fireEvent.change(screen.getByLabelText("Upload files"), { target: { files: [file] } });
    await screen.findByText("Uploaded 1 file.");
    expect(mockInvoke).toHaveBeenCalledWith("upload_file", { directory: "/project", name: "data.bin", content: [0, 255, 128] });
  });
  it("rejects oversized files before sending them", async () => {
    mount();
    const file = new File(["x"], "large.bin");
    Object.defineProperty(file, "size", { value: MAX_UPLOAD_BYTES + 1 });
    fireEvent.change(screen.getByLabelText("Upload files"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("10 MB or smaller"));
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "upload_file")).toBe(false);
  });
  it("drops into a folder and preserves internal file moves", async () => {
    mount();
    const folder = await screen.findByText("folder");
    fireEvent.drop(folder, { dataTransfer: { files: [new File(["hello"], "note.txt")], types: ["Files"] } });
    await screen.findByText("Uploaded 1 file.");
    expect(mockInvoke).toHaveBeenCalledWith("upload_file", expect.objectContaining({ directory: "/project/folder" }));
    fireEvent.drop(folder, { dataTransfer: { files: [], getData: () => "/project/source.txt" } });
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("move_file", { source: "/project/source.txt", destDir: "/project/folder" }));
  });
  it("reports backend failures and allows retry", async () => {
    mount();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "upload_file") throw "File exists";
      return [];
    });
    fireEvent.change(screen.getByLabelText("Upload files"), { target: { files: [new File([], "existing")] } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("File exists"));
    expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
  });
});
