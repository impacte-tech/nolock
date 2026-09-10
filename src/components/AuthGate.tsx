import { useEffect, useState } from "react";
import LoginPage from "./LoginPage";
import { getToken, clearToken } from "../web/auth";
import nolockLogo from "../assets/nolocklogo-green.svg";

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