import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AuthGate from "./components/AuthGate";
import { IS_WEB } from "./lib/webEnv";
import { seedLlamacppUrlFromServer } from "./lib/backends";
import "./styles.css";

// On the web target the whole app is gated behind the login page (AuthGate).
// The desktop build renders App directly — no auth.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {IS_WEB ? (
      <AuthGate>
        <App />
      </AuthGate>
    ) : (
      <App />
    )}
  </React.StrictMode>
);

// Web-only: auto-wire the llama.cpp service URL from the server config
// (`GET /api/config` → the `LLAMACPP_URL` Railway reference variable). Seeds a
// per-backend override (`nolock.url.llamacpp`) so the llamacpp provider works
// out of the box — unless the user already set a custom URL, which always wins.
// Runs again after login (see AuthGate) because the first attempt happens
// before the browser holds a valid token.

if (IS_WEB) {
  void seedLlamacppUrlFromServer();
}