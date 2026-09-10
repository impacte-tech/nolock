/**
 * Build-time web target detection.
 *
 * `__WEB_TARGET__` is injected by vite (`define`) only when the frontend is
 * built with `VITE_TARGET=web` (see `vite.config.ts`). In the desktop build
 * the identifier is never defined, so `typeof` short-circuits to `false`
 * without a ReferenceError.
 */

/** True when the frontend is built for the web target (VITE_TARGET=web). */
export const IS_WEB =
  typeof __WEB_TARGET__ !== "undefined" && __WEB_TARGET__;