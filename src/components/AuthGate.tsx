import { useEffect, useState } from "react";
import LoginPage from "./LoginPage";
import { getToken, setToken, clearToken, hasStoredToken } from "../web/auth";
import { seedLlamacppUrlFromServer } from "../lib/backends";
import nolockLogo from "../assets/nolock-mark-white.svg";

/**
 * Web-only auth gate. Rendered by `main.tsx` around the whole app when the
 * frontend is built for the web target. Validates any stored token against the
 * server; shows the login page when there is no (valid) token.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "authed" | "unauthed">(
    "loading",
  );

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setState("unauthed");
      return;
    }
    fetch("/api/auth/check", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.ok) {
          // A token that arrived via the URL (`?token=…`) is read by getToken()
          // but never stored — persist it per-tab so the session survives
          // reloads without the query parameter. Tokens entered on the login
          // page are already stored, and stored tokens always win.
          if (!hasStoredToken()) {
            setToken(token, false);
          }
          // Wire deployment-provided provider config (llama.cpp URL) now that
          // the token is valid — the startup attempt ran before any token.
          void seedLlamacppUrlFromServer();
          setState("authed");
        } else {
          clearToken();
          setState("unauthed");
        }
      })
      .catch(() => {
        clearToken();
        setState("unauthed");
      });
  }, []);

  if (state === "loading") {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <img src={nolockLogo} alt="nolock" className="auth-logo" />
          <p className="auth-subtitle">Checking access…</p>
        </div>
      </div>
    );
  }
  if (state === "unauthed") {
    return <LoginPage onAuthenticated={() => setState("authed")} />;
  }
  return <>{children}</>;
}