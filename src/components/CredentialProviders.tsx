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
    <p className="provider-help">Keep secrets in your password manager — never paste them into chat. Your choice is saved immediately; no credentials are stored by nolock.</p>
    <div role="group" aria-label="Credential provider" className="provider-options">
      <button type="button" className="btn-secondary" aria-pressed={provider === "1password"} onClick={() => choose("1password")}>1Password</button>
      <button type="button" className="btn-secondary" aria-pressed={provider === "bitwarden"} onClick={() => choose("bitwarden")}>Bitwarden</button>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check installed CLIs"}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <p role="status">{!availability ? "CLI availability not checked yet." : provider === "1password"
      ? `1Password CLI (op): ${availability.onePassword ? "found" : "not found"}.`
      : `Password Manager CLI (bw): ${availability.bitwarden ? "found" : "not found"}. Secrets Manager CLI (bws): ${availability.bitwardenSecrets ? "found" : "not found"}.`}</p>
    {provider === "1password" ? <ol>
      <li><strong>Install &amp; unlock.</strong> <a href="https://developer.1password.com/docs/cli/get-started/" target="_blank" rel="noreferrer">1Password CLI</a> + desktop app; enable “Integrate with 1Password CLI” in Developer settings.</li>
      <li><strong>Store references, not values.</strong> Put <code>op://</code> references in <code>secrets.refs</code>:
        {command("SUPABASE_SECRET_KEY=op://Development/Supabase/credential")}
      </li>
      <li><strong>Run a trusted app.</strong> References resolve into the process environment:
        {command("op run --env-file=secrets.refs -- your-app")}
      </li>
    </ol> : <>
      <ol>
        <li><strong>Pick the CLI.</strong> <a href="https://bitwarden.com/help/cli/" target="_blank" rel="noreferrer">bw</a> (personal vault) or <a href="https://bitwarden.com/help/secrets-manager-cli/" target="_blank" rel="noreferrer">bws</a> (Secrets Manager, machine tokens).</li>
        <li><strong>Unlock in your terminal.</strong> End with <code>bw lock</code> when done:
          {command('export BW_SESSION="$(bw unlock --raw)"')}
        </li>
        <li><strong>Pass one value.</strong> Through the environment — never printed:
          {command('SUPABASE_SECRET_KEY="$(bw get password ITEM_ID)" your-app')}
        </li>
      </ol>
      <details><summary>Using Secrets Manager (bws) instead</summary>
        <p>Create a machine account for the project, set <code>BWS_ACCESS_TOKEN</code> in your own terminal, then run:</p>
        {command("bws run --project-id YOUR_PROJECT_ID -- 'your-app'")}
      </details>
    </>}
    <details className="provider-protection">
      <summary>AI file protection (always on)</summary>
      <ul>
        <li><code>.env</code> files (variants, backups, examples) and credential directories are excluded from AI reads and context — symlink and hardlink aliases included.</li>
        <li>Terminal input isn't recorded, so password and MFA prompts stay out of command memory.</li>
        <li>Code execution tools stay off unless you enable them in the Code execution group above.</li>
      </ul>
    </details>
  </section>;
}
