# Credential providers and AI file protection

Open **Tools → Credential providers**, choose 1Password or Bitwarden, and follow the setup steps. Nolock saves the provider choice and checks CLI availability on the host. It does not authenticate to the vault, store vault passwords or session tokens, fetch secret values, or automatically run commands. In web mode the check refers to the server host.

Authenticate in your own terminal. With 1Password, use secret references and `op run` to supply environment variables to a trusted application. With Bitwarden Password Manager, unlock `bw` in your terminal and supply only the item needed by the application. `bws` is the separate Secrets Manager product, with machine-account authentication. The UI includes copyable examples and official setup links.

For AWS, continue managing CLI authentication in your terminal. For Supabase or other API keys, keep the value in the vault and provide it only to applications that need it. Review agent-written code before running it with credentials: a child process can print or transmit any secret it receives.

## Enforced boundary

Agent file reads, searches, file-edit previews, attached-file context and editor inline completion reject paths containing `.env` (case insensitive), including `.env.local`, `.env.example`, `.envrc`, `production.env` and backups. Known credential directories are also excluded. Canonical paths are checked; Unix hard-linked files are conservatively excluded. Linux file reads additionally validate the opened file descriptor. Manual editor reads and the normal terminal remain available.

Automatic agent shell, Rust, custom-command and delegated execution is disabled because it could bypass these checks. This is an application policy, not an OS sandbox. Nolock no longer records raw terminal input as command memory or triggers hooks from it, since password/MFA input cannot reliably be distinguished from commands.

The policy cannot identify secrets pasted into chat or copied into unrelated filenames. It does not remove content already present in old conversations, command memory or remote providers. Start a new conversation if an older conversation already contains sensitive context.

Provider documentation: [1Password runtime injection](https://developer.1password.com/docs/cli/secrets-scripts/), [Bitwarden Password Manager CLI](https://bitwarden.com/help/cli/), [Bitwarden Secrets Manager CLI](https://bitwarden.com/help/secrets-manager-cli/).
