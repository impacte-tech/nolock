import { useState, useCallback } from "react";
import { setToken } from "../web/auth";
import nolockLogo from "../assets/nolock-mark-white.svg";

interface Props {
  onAuthenticated: () => void;
}

/**
 * Web-only login page. The user pastes the `NOLOCK_WEB_TOKEN` value; the token
 * is validated against the server's `/api/auth/check` endpoint before it is
 * stored and the app is unlocked.
 */
export default function LoginPage({ onAuthenticated }: Props) {
  const [token, setTokenValue] = useState("");
  const [remember, setRemember] = useState(true);
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const value = token.trim();
    if (!value) {
      setError("Please enter your access token.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/check", {
        headers: { Authorization: `Bearer ${value}` },
      });
      if (res.ok) {
        setToken(value, remember);
        onAuthenticated();
      } else if (res.status === 401) {
        setError("Invalid access token. Check the NOLOCK_WEB_TOKEN value.");
      } else {
        setError(`Server error (HTTP ${res.status}). Try again shortly.`);
      }
    } catch {
      setError("Could not reach the nolock server. Is it running?");
    } finally {
      setBusy(false);
    }
  }, [token, remember, onAuthenticated]);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <img src={nolockLogo} alt="nolock" className="auth-logo" />
        <h1 className="auth-title">nolock</h1>
        <p className="auth-subtitle">Sign in to continue to your workspace</p>
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="auth-label" htmlFor="auth-token">
            Access token
          </label>
          <div className="auth-input-row">
            <input
              id="auth-token"
              className="auth-input"
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => setTokenValue(e.target.value)}
              placeholder="Paste your NOLOCK_WEB_TOKEN"
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="auth-toggle"
              onClick={() => setShowToken(!showToken)}
              aria-label={showToken ? "Hide token" : "Show token"}
            >
              {showToken ? "Hide" : "Show"}
            </button>
          </div>
          <label className="auth-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember me on this device
          </label>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}