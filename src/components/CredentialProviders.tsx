import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Availability { onePassword: boolean; bitwarden: boolean; bitwardenSecrets: boolean }
export default function CredentialProviders() {
  const [provider, setProvider] = useState(() => localStorage.getItem("nolock.credentialProvider") === "bitwarden" ? "bitwarden" : "1password");
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const check = async () => {
    setBusy(true); setError("");
    try { setAvailability(await invoke<Availability>("credential_provider_availability")); }
    catch { setError("Could not check CLI availability on the nolock host. You can still follow the setup steps below."); }
    finally { setBusy(false); }
  };
  useEffect(() => { void check(); }, []);
  const choose = (value: string) => {
    setProvider(value); localStorage.setItem("nolock.credentialProvider", value); setCopied("");
  };
  const command = (value: string) => <div className="provider-command"><pre>{value}</pre><button type="button" className="btn-secondary" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(value); }
    catch { setError("Clipboard unavailable. Select and copy the command manually."); }
  }}>{copied === value ? "Copied" : "Copy"}</button></div>;
  return <section className="credential-providers" aria-labelledby="credential-providers-title">
    <h3 id="credential-providers-title">Credential providers</h3>
    <p>Keep secrets in a password manager. Authenticate and run trusted applications in your terminal; nolock never asks for your master password or loads vault secrets into chat.</p>
    <div role="group" aria-label="Credential provider" className="provider-options">
      <button type="button" className="btn-secondary" aria-pressed={provider === "1password"} onClick={() => choose("1password")}>1Password</button>
      <button type="button" className="btn-secondary" aria-pressed={provider === "bitwarden"} onClick={() => choose("bitwarden")}>Bitwarden</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <p role="status">{!availability ? "CLI availability not checked yet." : provider === "1password"
      ? `1Password CLI (op): ${availability.onePassword ? "found" : "not found"}.`
      : `Password Manager CLI (bw): ${availability.bitwarden ? "found" : "not found"}. Secrets Manager CLI (bws): ${availability.bitwardenSecrets ? "found" : "not found"}.`}</p>
    <button type="button" className="btn-secondary" disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check installed CLIs"}</button>
    <p className="provider-help">This checks executable availability on the nolock host only. It does not authenticate, unlock a vault, or read secrets. Your provider choice is saved immediately; no credentials are saved in browser storage.</p>
    {provider === "1password" ? <ol>
      <li><strong>Install and unlock.</strong> Install the <a href="https://developer.1password.com/docs/cli/get-started/" target="_blank" rel="noreferrer">1Password CLI</a> and desktop app. Enable “Integrate with 1Password CLI” in the app’s Developer settings, then unlock the app.</li>
      <li><strong>Use references.</strong> Store the API key in a dedicated vault/item. Copy its secret reference from 1Password, and put references—not actual values—in a file named <code>secrets.refs</code>. For example:
        {command("SUPABASE_SECRET_KEY=op://Development/Supabase/credential")}
        Replace that sample vault/item/field with your own reference. The file contains metadata about the vault, so share it only where appropriate.</li>
      <li><strong>Run a trusted application.</strong> In your terminal, replace <code>your-app</code> with the command you intend to run:
        {command("op run --env-file=secrets.refs -- your-app")}
        1Password resolves references into the child process environment. Do not use <code>op read</code> to paste secret values into chat.</li>
    </ol> : <>
      <ol>
        <li><strong>Choose the right CLI.</strong> <a href="https://bitwarden.com/help/cli/" target="_blank" rel="noreferrer">Password Manager CLI (bw)</a> uses your personal vault. <a href="https://bitwarden.com/help/secrets-manager-cli/" target="_blank" rel="noreferrer">Secrets Manager CLI (bws)</a> is a separate developer product using machine-account access tokens.</li>
        <li><strong>Unlock in your terminal.</strong> For Password Manager, log in with <code>bw login</code>. An existing login can be unlocked without printing the session token:
          {command('export BW_SESSION="$(bw unlock --raw)"')}
          Never paste the session token or your master password into chat. End the session with <code>bw lock</code> when finished.</li>
        <li><strong>Pass one value to a trusted application.</strong> Store the API key in an item’s password field. Replace the item ID and application name:
          {command('SUPABASE_SECRET_KEY="$(bw get password ITEM_ID)" your-app')}
          This passes the value through the process environment without printing it. Disable shell tracing with <code>set +x</code> before handling secrets.</li>
      </ol>
      <details><summary>Using Bitwarden Secrets Manager instead</summary>
        <p>Create a machine account limited to the project you need. Configure <code>BWS_ACCESS_TOKEN</code> securely in your own terminal; do not put the token in project files or nolock settings. Follow the official CLI authentication guide, then run:</p>
        {command("bws run --project-id YOUR_PROJECT_ID -- 'your-app'")}
        <p>Unset the token when done. This is separate from <code>BW_SESSION</code> and a Password Manager login.</p>
      </details>
    </>}
    <aside className="provider-protection"><strong>AI file protection is always on</strong>
      <p>Files whose names contain <code>.env</code> (including variants, backups and examples) and known credential directories are excluded from AI file reads and context. Symlink targets and hard-linked aliases are checked too. Open these files in your editor or terminal when you need them.</p>
      <p>Terminal input is not recorded by nolock, so password and MFA prompts stay out of command memory and hooks. Manually pasted secrets and copies stored under other filenames cannot be identified by this file policy.</p>
      <p>Automatic host-shell, Rust, custom-command and delegated execution is disabled until it has an OS sandbox. The normal terminal remains available. A vault does not make untrusted code safe: an application that receives secrets can print or transmit them. Review agent-written code before running it with credentials.</p>
    </aside>
  </section>;
}
