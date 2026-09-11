import { invoke } from "@tauri-apps/api/core";

export const MAX_UPLOAD_BYTES = 10_000_000;

export async function uploadFile(directory: string, file: File): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("Files must be 10 MB or smaller.");
  const content = await new Promise<number[]>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Cannot read ${file.name}.`));
    reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled.`));
    reader.onload = () => resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
    reader.readAsArrayBuffer(file);
  });
  return invoke<string>("upload_file", { directory, name: file.name, content });
}
