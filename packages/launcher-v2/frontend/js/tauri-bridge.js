/**
 * Tauri IPC bridge — thin wrappers over the global `__TAURI__` API.
 *
 * This file is the only place that touches Tauri internals directly. All
 * other frontend JS imports from here so the binding details can change
 * without rippling across the codebase.
 *
 * Requires `app.withGlobalTauri = true` in `tauri.conf.json` (set). Tauri
 * injects the IPC API as a property on the webview's global object — in
 * a browser context `globalThis === window`, so either accessor works;
 * we use `globalThis` to avoid Deno's no-window lint.
 */

const tauri = globalThis.__TAURI__;

if (!tauri) {
  console.error(
    "[launcher] globalThis.__TAURI__ is undefined. Set app.withGlobalTauri=true in tauri.conf.json.",
  );
}

export const invoke = (name, args) => tauri.core.invoke(name, args);
export const listen = (eventName, handler) =>
  tauri.event.listen(eventName, handler);

/**
 * Tiny helper that wraps invoke() with try/catch so callers don't have to
 * remember the boilerplate. Returns `{ ok: T, err: null } | { ok: null,
 * err: string }`.
 */
export async function safeInvoke(name, args) {
  try {
    const result = await invoke(name, args);
    return { ok: result, err: null };
  } catch (err) {
    return { ok: null, err: String(err) };
  }
}
