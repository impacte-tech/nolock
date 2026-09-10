import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AuthGate from "./components/AuthGate";
import { IS_WEB } from "./lib/webEnv";
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