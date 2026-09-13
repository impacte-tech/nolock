import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import CredentialProviders from "../CredentialProviders";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
it("checks availability without requesting vault values and persists only the provider choice", async () => {
  vi.mocked(invoke).mockResolvedValue({ onePassword: true, bitwarden: false, bitwardenSecrets: false });
  render(<CredentialProviders />);
  await screen.findByText("1Password CLI (op): found.");
  fireEvent.click(screen.getByRole("button", { name: "Bitwarden" }));
  expect(localStorage.getItem("nolock.credentialProvider")).toBe("bitwarden");
  expect(localStorage.length).toBe(1);
  expect(screen.getByText(/Password Manager CLI \(bw\): not found/)).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls).toEqual([["credential_provider_availability"]]);
});
it("handles an unavailable backend without pretending the vault is connected", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("offline"));
  render(<CredentialProviders />);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not check"));
  expect(screen.getByRole("button", { name: "Check installed CLIs" }).hasAttribute("disabled")).toBe(false);
});
