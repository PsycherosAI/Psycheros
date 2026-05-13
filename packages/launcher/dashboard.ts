/**
 * Psycheros Web Dashboard
 *
 * A browser-based GUI for installing, updating, and running Psycheros.
 * No CLI needed — just run this file with Deno and click buttons.
 */

// --- Constants ---

// Default to the public canonical repo. Set PSYCHEROS_REPO to override (e.g.
// "PsycherosAI/Psycheros-staging" or a full URL) when testing the install flow
// against a fork or the private staging repo.
function resolveMonorepoSlug(): string {
  const input = Deno.env.get("PSYCHEROS_REPO") ?? "PsycherosAI/Psycheros";
  return input
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "");
}
const MONOREPO_REPO = resolveMonorepoSlug();
const PSYCHEROS_PACKAGE = "psycheros";
const ENTITY_LOOM_PACKAGE = "entity-loom";
const ENTITY_LOOM_PORT = 3210;
// Launcher dashboard binds here. Override with PSYCHEROS_LAUNCHER_PORT when
// :3001 is already in use (uptimekuma, Verdaccio, and other common homelab
// tools all squat here). The launcher's own port is independent of the
// psycheros daemon's port — that's PSYCHEROS_PORT and lives in psycheros's
// .env, read at runtime by /api/psycheros-url.
const PORT = parseInt(Deno.env.get("PSYCHEROS_LAUNCHER_PORT") ?? "3001", 10);
const MAX_LOG_LINES = 500;

// --- State ---

let psycherosProcess: Deno.ChildProcess | null = null;
let entityLoomProcess: Deno.ChildProcess | null = null;
let isRunning = false;
let entityLoomRunning = false;
let hasGit = false;
const logBuffer: string[] = [];
const logListeners = new Set<(entry: string) => void>();

// --- Settings ---

interface Settings {
  installDir: string;
  userName: string;
  entityName: string;
  timezone: string;
}

function resolveHome(p: string): string {
  if (p.startsWith("~")) {
    const home = Deno.build.os === "windows"
      ? (Deno.env.get("USERPROFILE") ||
        `${Deno.env.get("HOMEDRIVE") || ""}${Deno.env.get("HOMEPATH") || ""}`)
      : (Deno.env.get("HOME") || "");
    const resolved = p.replace("~", home);
    // Normalize separators on Windows to avoid mixed / and \ paths
    if (Deno.build.os === "windows") {
      return resolved.replace(/\//g, "\\");
    }
    return resolved;
  }
  return p;
}

function defaultSettings(): Settings {
  return {
    installDir: resolveHome("~/psycheros"),
    userName: "You",
    entityName: "Assistant",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function getConfigDir(): string {
  if (Deno.build.os === "windows") {
    const appData = Deno.env.get("APPDATA") || Deno.env.get("LOCALAPPDATA") ||
      "";
    if (appData) return pathJoin(appData, "psycheros-launcher");
  }
  return resolveHome("~");
}

function getDashboardStatePath(): string {
  if (Deno.build.os === "windows") {
    return pathJoin(getConfigDir(), "state.json");
  }
  return resolveHome("~/.psycheros-launcher-state.json");
}

function getLegacyStatePath(): string {
  return resolveHome("~/.psycheros-launcher-state.json");
}

function pathJoin(...parts: string[]): string {
  const sep = Deno.build.os === "windows" ? "\\" : "/";
  return parts.map((p) => p.replace(/[\/\\]+$/, "")).filter(Boolean).join(sep);
}

function pathDirname(p: string): string {
  // Strip trailing separators, then drop the last component
  const trimmed = p.replace(/[\/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return ".";
  const parent = trimmed.slice(0, idx);
  return parent || (Deno.build.os === "windows" ? trimmed.slice(0, 1) : "/");
}

function psycherosPackageDir(installDir: string): string {
  return pathJoin(installDir, "packages", PSYCHEROS_PACKAGE);
}

function entityLoomPackageDir(installDir: string): string {
  return pathJoin(installDir, "packages", ENTITY_LOOM_PACKAGE);
}

function legacyPsycherosDir(installDir: string): string {
  // The old launcher cloned Psycheros into <base>/Psycheros — keep the path so
  // we can read its general-settings.json on first run after the upgrade.
  return pathJoin(installDir, "Psycheros");
}

function loadSettings(): Settings {
  let installDir = "";

  // Try new path first, then legacy path (for migration from older versions).
  const statePaths = [getDashboardStatePath(), getLegacyStatePath()];
  for (const statePath of statePaths) {
    try {
      const state = JSON.parse(Deno.readTextFileSync(statePath));
      if (typeof state.installDir === "string" && state.installDir) {
        installDir = state.installDir;
        break;
      }
      // Old-launcher state held three sibling clone targets — derive the
      // monorepo root from the parent of the Psycheros checkout.
      if (typeof state.psycherosDir === "string" && state.psycherosDir) {
        installDir = pathDirname(state.psycherosDir);
        break;
      }
    } catch { /* try next path */ }
  }

  const prefs = defaultSettings();
  if (installDir) {
    prefs.installDir = installDir;
    // Read user prefs from the in-tree settings file. Try the monorepo
    // location first, then fall back to the legacy single-repo location.
    const settingsCandidates = [
      pathJoin(
        psycherosPackageDir(installDir),
        ".psycheros",
        "general-settings.json",
      ),
      pathJoin(
        legacyPsycherosDir(installDir),
        ".psycheros",
        "general-settings.json",
      ),
    ];
    for (const settingsFile of settingsCandidates) {
      try {
        const saved = JSON.parse(Deno.readTextFileSync(settingsFile));
        prefs.userName = saved.userName || prefs.userName;
        prefs.entityName = saved.entityName || prefs.entityName;
        prefs.timezone = saved.timezone || prefs.timezone;
        break;
      } catch {
        // Try next candidate.
      }
    }
  }

  return prefs;
}

function saveDashboardState(settings: Settings): void {
  try {
    const statePath = getDashboardStatePath();
    Deno.mkdirSync(getConfigDir(), { recursive: true });
    Deno.writeTextFileSync(
      statePath,
      JSON.stringify({ installDir: settings.installDir }, null, 2),
    );
  } catch (e) {
    appendLog(
      `WARNING: Failed to save dashboard state to ${getDashboardStatePath()}: ${e}`,
    );
  }
}

function savePsycherosSettings(settings: Settings): void {
  const dir = pathJoin(psycherosPackageDir(settings.installDir), ".psycheros");
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(
    pathJoin(dir, "general-settings.json"),
    JSON.stringify(
      {
        entityName: settings.entityName,
        userName: settings.userName,
        timezone: settings.timezone,
      },
      null,
      2,
    ) + "\n",
  );
}

// --- Logging ---

// Strip ANSI escape sequences (color, cursor-move) so subprocess output stays
// readable in the dashboard's HTML log panel — most CLIs detect "not a TTY"
// and disable color, but Deno's task runner and a few of its subprocesses
// emit them regardless.
// deno-lint-ignore no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function appendLog(text: string): void {
  const lines = text.replace(ANSI_RE, "").split("\n").filter((l) => l.trim());
  for (const line of lines) {
    const timestamped = `[${new Date().toLocaleTimeString()}] ${line}`;
    logBuffer.push(timestamped);
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
    for (const listener of logListeners) {
      try {
        listener(timestamped);
      } catch { /* client gone */ }
    }
  }
}

// --- Command execution ---

async function runCommand(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; output: string }> {
  appendLog(`> ${cmd} ${args.join(" ")}`);
  const command = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();

  const stdout = new TextDecoder();
  const stderr = new TextDecoder();
  let output = "";

  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    decoder: TextDecoder,
  ) => {
    const reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      output += text;
      appendLog(text);
    }
    const final = decoder.decode();
    if (final) {
      output += final;
      appendLog(final);
    }
  };

  await Promise.all([
    readStream(child.stdout!, stdout),
    readStream(child.stderr!, stderr),
  ]);

  const status = await child.status;
  return { code: status.code, output };
}

// --- Prerequisites check ---

async function checkPrerequisites(): Promise<{ git: boolean; deno: boolean }> {
  let deno = false;
  try {
    const r = await runCommand("git", ["--version"]);
    hasGit = r.code === 0;
  } catch {
    hasGit = false;
  }
  try {
    const r = await runCommand("deno", ["--version"]);
    deno = r.code === 0;
  } catch { /* not found */ }
  return { git: hasGit, deno };
}

// --- Clone / update monorepo ---

async function isMonorepoCheckout(installDir: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(pathJoin(installDir, ".git"));
    if (!stat.isDirectory) return false;
  } catch {
    return false;
  }
  try {
    // Sanity check: the monorepo's packages/psycheros must be present.
    const stat = await Deno.stat(psycherosPackageDir(installDir));
    return stat.isDirectory;
  } catch {
    return false;
  }
}

async function cloneOrUpdateMonorepo(installDir: string): Promise<boolean> {
  // Refresh hasGit in case the dashboard was driven over HTTP without the UI
  // ever firing /api/prerequisites — otherwise we'd silently fall through to
  // the tar path even when git is available.
  if (!hasGit) {
    await checkPrerequisites();
  }

  if (await isMonorepoCheckout(installDir)) {
    appendLog(`Monorepo already present at ${installDir}, updating...`);
    const r = await runCommand("git", ["-C", installDir, "pull", "--ff-only"]);
    return r.code === 0;
  }

  // Reject any non-empty existing dir — both `git clone` and the tar fallback
  // would otherwise mix new files into an old three-repo install.
  let dirExists = false;
  try {
    const stat = await Deno.stat(installDir);
    dirExists = stat.isDirectory;
  } catch { /* missing, will be created by clone */ }

  if (dirExists) {
    let hasEntries = false;
    for await (const _ of Deno.readDir(installDir)) {
      hasEntries = true;
      break;
    }
    if (hasEntries) {
      appendLog(
        `${installDir} exists and is not a monorepo checkout. ` +
          `Click "Wipe All Data" to clear it (this will delete everything in ` +
          `${installDir}), then try again.`,
      );
      return false;
    }
  }

  if (hasGit) {
    appendLog(`Cloning ${MONOREPO_REPO}...`);
    const r = await runCommand("git", [
      "clone",
      `https://github.com/${MONOREPO_REPO}.git`,
      installDir,
    ]);
    return r.code === 0;
  }

  return await downloadMonorepo(installDir);
}

async function downloadMonorepo(installDir: string): Promise<boolean> {
  appendLog(`Downloading ${MONOREPO_REPO}...`);
  try {
    const tarUrl =
      `https://github.com/${MONOREPO_REPO}/archive/refs/heads/main.tar.gz`;
    const response = await fetch(tarUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const tarData = new Uint8Array(await response.arrayBuffer());

    // Decompress gzip
    const decompressed = new Uint8Array(
      await new Response(
        new Response(tarData).body!.pipeThrough(
          new DecompressionStream("gzip"),
        ),
      ).arrayBuffer(),
    );

    // Parse tar and extract
    let offset = 0;
    while (offset < decompressed.length - 512) {
      const nameBytes = decompressed.slice(offset, offset + 100);
      const nameStr = new TextDecoder().decode(nameBytes).replace(/\0.*$/, "");
      const sizeOctal = new TextDecoder().decode(
        decompressed.slice(offset + 124, offset + 136),
      ).replace(/\0/g, "").trim();
      const size = parseInt(sizeOctal || "0", 8);

      if (!nameStr || nameStr.endsWith("/")) {
        offset += 512;
        continue;
      }

      offset += 512;
      if (size > 0) {
        // Strip the repo-branch prefix (e.g. "psycheros-main/")
        const parts = nameStr.split("/");
        const localName = parts.slice(1).join("/");
        const localPath = localName
          ? pathJoin(installDir, localName)
          : installDir;
        const dir = pathJoin(localPath, "..");

        try {
          Deno.mkdirSync(dir, { recursive: true });
        } catch { /* exists */ }
        Deno.writeFileSync(
          localPath,
          decompressed.slice(offset, offset + size),
        );
        offset += 512 * Math.ceil(size / 512);
      }
    }
    appendLog(`Monorepo downloaded to ${installDir}.`);
    return true;
  } catch (e) {
    appendLog(`Failed to download monorepo: ${e}`);
    return false;
  }
}

// --- Process management ---

async function streamProcessOutput(process: Deno.ChildProcess): Promise<void> {
  isRunning = true;
  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    _label: string,
  ) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      appendLog(text);
    }
    const final = decoder.decode();
    if (final) appendLog(final);
  };

  await Promise.all([
    readStream(process.stdout!, "stdout"),
    readStream(process.stderr!, "stderr"),
  ]);

  const status = await process.status;
  appendLog(`Psycheros exited with code ${status.code}`);
  psycherosProcess = null;
  isRunning = false;
}

async function startPsycheros(
  installDir: string,
): Promise<{ success: boolean; message: string }> {
  if (isRunning) {
    return { success: false, message: "Psycheros is already running." };
  }
  const pkgDir = psycherosPackageDir(installDir);
  appendLog(`startPsycheros: checking ${pkgDir}`);
  try {
    await Deno.stat(pkgDir);
  } catch (e) {
    appendLog(`startPsycheros: stat failed — ${e}`);
    return {
      success: false,
      message: `Psycheros not found at ${pkgDir}. Click Install first.`,
    };
  }

  appendLog("Starting Psycheros...");
  const command = new Deno.Command("deno", {
    args: ["task", "start"],
    cwd: pkgDir,
    stdout: "piped",
    stderr: "piped",
  });
  psycherosProcess = command.spawn();
  streamProcessOutput(psycherosProcess);
  return { success: true, message: "Psycheros is starting..." };
}

async function stopPsycheros(): Promise<{ success: boolean; message: string }> {
  if (!psycherosProcess || !isRunning) {
    return { success: false, message: "Psycheros is not running." };
  }

  appendLog("Stopping Psycheros...");
  try {
    psycherosProcess.kill("SIGINT");
  } catch {
    try {
      psycherosProcess.kill("SIGTERM");
    } catch {
      // On Windows, fall back to taskkill
      if (Deno.build.os === "windows" && psycherosProcess.pid) {
        try {
          await runCommand("taskkill", [
            "/pid",
            psycherosProcess.pid.toString(),
            "/f",
            "/t",
          ]);
        } catch { /* give up */ }
      }
    }
  }

  // Wait up to 10 seconds for graceful exit — psycheros's MCP teardown has
  // its own SIGTERM→SIGKILL escalation that can eat ~4s, plus optional state
  // flush. 5s used to clip that window and orphan entity-core.
  try {
    await Promise.race([
      psycherosProcess.status,
      new Promise((_, reject) => setTimeout(() => reject("timeout"), 10000)),
    ]);
  } catch {
    if (psycherosProcess) {
      try {
        psycherosProcess.kill("SIGKILL");
      } catch { /* ignore */ }
      if (Deno.build.os === "windows" && psycherosProcess.pid) {
        try {
          await runCommand("taskkill", [
            "/pid",
            psycherosProcess.pid.toString(),
            "/f",
            "/t",
          ]);
        } catch { /* ignore */ }
      }
    }
  }

  psycherosProcess = null;
  isRunning = false;
  appendLog("Psycheros stopped.");
  return { success: true, message: "Psycheros stopped." };
}

// --- Entity Loom process management ---

async function streamEntityLoomOutput(
  process: Deno.ChildProcess,
): Promise<void> {
  entityLoomRunning = true;
  const readStream = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      appendLog(text);
    }
    const final = decoder.decode();
    if (final) appendLog(final);
  };

  await Promise.all([
    readStream(process.stdout!),
    readStream(process.stderr!),
  ]);

  const status = await process.status;
  appendLog(`Entity Loom exited with code ${status.code}`);
  entityLoomProcess = null;
  entityLoomRunning = false;
}

async function startEntityLoom(
  installDir: string,
): Promise<{ success: boolean; message: string }> {
  if (entityLoomRunning) {
    return { success: false, message: "Entity Loom is already running." };
  }
  const pkgDir = entityLoomPackageDir(installDir);
  try {
    await Deno.stat(pkgDir);
  } catch {
    return {
      success: false,
      message:
        `Entity Loom not found at ${pkgDir}. Click Install to get the monorepo first.`,
    };
  }

  appendLog("Starting Entity Loom...");
  const command = new Deno.Command("deno", {
    args: ["task", "start"],
    cwd: pkgDir,
    stdout: "piped",
    stderr: "piped",
  });
  entityLoomProcess = command.spawn();
  streamEntityLoomOutput(entityLoomProcess);
  return { success: true, message: "Entity Loom is starting..." };
}

async function stopEntityLoom(): Promise<
  { success: boolean; message: string }
> {
  if (!entityLoomProcess || !entityLoomRunning) {
    return { success: false, message: "Entity Loom is not running." };
  }

  appendLog("Stopping Entity Loom...");
  try {
    entityLoomProcess.kill("SIGINT");
  } catch {
    try {
      entityLoomProcess.kill("SIGTERM");
    } catch {
      if (Deno.build.os === "windows" && entityLoomProcess.pid) {
        try {
          await runCommand("taskkill", [
            "/pid",
            entityLoomProcess.pid.toString(),
            "/f",
            "/t",
          ]);
        } catch { /* give up */ }
      }
    }
  }

  try {
    await Promise.race([
      entityLoomProcess.status,
      new Promise((_, reject) => setTimeout(() => reject("timeout"), 5000)),
    ]);
  } catch {
    if (entityLoomProcess) {
      try {
        entityLoomProcess.kill("SIGKILL");
      } catch { /* ignore */ }
      if (Deno.build.os === "windows" && entityLoomProcess.pid) {
        try {
          await runCommand("taskkill", [
            "/pid",
            entityLoomProcess.pid.toString(),
            "/f",
            "/t",
          ]);
        } catch { /* ignore */ }
      }
    }
  }

  entityLoomProcess = null;
  entityLoomRunning = false;
  appendLog("Entity Loom stopped.");
  return { success: true, message: "Entity Loom stopped." };
}

// --- Request handling ---

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // --- API routes ---

  if (path === "/api/status") {
    const settings = loadSettings();
    let installed = false;
    try {
      installed =
        (await Deno.stat(psycherosPackageDir(settings.installDir))).isDirectory;
    } catch { /* not installed */ }
    return json({ running: isRunning, entityLoomRunning, installed });
  }

  if (path === "/api/prerequisites") {
    const prereqs = await checkPrerequisites();
    return json(prereqs);
  }

  if (path === "/api/settings" && req.method === "GET") {
    return json(loadSettings());
  }

  if (path === "/api/logs") {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        // Send buffered logs
        for (const line of logBuffer) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text: line })}\n\n`),
          );
        }
        // Register for future logs
        const listener = (entry: string) => {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: entry })}\n\n`),
            );
          } catch {
            logListeners.delete(listener);
          }
        };
        logListeners.add(listener);
      },
      cancel() {
        // Clean up is handled by the try/catch in the listener
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (path === "/api/install" && req.method === "POST") {
    const body = await req.json() as Partial<Settings>;

    const defaults = defaultSettings();
    const settings: Settings = {
      installDir: body.installDir
        ? resolveHome(body.installDir)
        : defaults.installDir,
      userName: body.userName || "You",
      entityName: body.entityName || "Assistant",
      timezone: body.timezone ||
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    };

    appendLog(`Installing Psycheros monorepo to ${settings.installDir}...`);
    Deno.mkdirSync(pathDirname(settings.installDir), { recursive: true });

    const ok = await cloneOrUpdateMonorepo(settings.installDir);
    if (!ok) {
      return json(
        { success: false, message: "Failed to install monorepo." },
        500,
      );
    }

    savePsycherosSettings(settings);
    saveDashboardState(settings);
    appendLog("Installation complete!");
    return json({ success: true, message: "Installation complete!" });
  }

  if (path === "/api/save-settings" && req.method === "POST") {
    const body = await req.json() as Partial<Settings>;
    const current = loadSettings();
    const settings: Settings = {
      installDir: body.installDir
        ? resolveHome(body.installDir)
        : current.installDir,
      userName: body.userName || current.userName,
      entityName: body.entityName || current.entityName,
      timezone: body.timezone || current.timezone,
    };

    try {
      await Deno.stat(psycherosPackageDir(settings.installDir));
    } catch {
      return json({
        success: false,
        message:
          `${psycherosPackageDir(settings.installDir)} does not exist. ` +
          `Click Install or point to a valid monorepo checkout.`,
      });
    }

    savePsycherosSettings(settings);
    saveDashboardState(settings);
    appendLog("Settings saved.");
    return json({ success: true, message: "Settings saved." });
  }

  if (path === "/api/update" && req.method === "POST") {
    const settings = loadSettings();

    // Refresh the module-level hasGit flag so the no-git fallback can kick in.
    if (!hasGit) {
      await checkPrerequisites();
    }

    if (hasGit) {
      appendLog(`Updating monorepo at ${settings.installDir}...`);
      const r = await runCommand("git", [
        "-C",
        settings.installDir,
        "pull",
        "--ff-only",
      ]);
      if (r.code !== 0) {
        return json(
          { success: false, message: "Failed to update monorepo." },
          500,
        );
      }
    } else {
      appendLog("Git not available — re-downloading monorepo...");
      const ok = await downloadMonorepo(settings.installDir);
      if (!ok) {
        return json(
          { success: false, message: "Failed to update monorepo." },
          500,
        );
      }
    }

    appendLog("Update complete!");
    return json({ success: true, message: "Update complete!" });
  }

  if (path === "/api/wipe" && req.method === "POST") {
    // Stop running processes first
    if (isRunning) {
      await stopPsycheros();
    }
    if (entityLoomRunning) {
      await stopEntityLoom();
    }

    const settings = loadSettings();

    let wiped = true;
    try {
      await Deno.remove(settings.installDir, { recursive: true });
      appendLog(`Deleted: ${settings.installDir}`);
    } catch (e) {
      // ENOENT is fine — nothing to wipe.
      if (e instanceof Deno.errors.NotFound) {
        appendLog(`No install at ${settings.installDir} — nothing to delete.`);
      } else {
        appendLog(`Failed to delete ${settings.installDir}: ${e}`);
        wiped = false;
      }
    }

    if (wiped) {
      for (const p of [getDashboardStatePath(), getLegacyStatePath()]) {
        try {
          await Deno.remove(p);
        } catch { /* no file */ }
      }
      appendLog("Deleted dashboard state file.");
    } else {
      appendLog("Dashboard state preserved because wipe failed.");
    }

    psycherosProcess = null;
    isRunning = false;
    entityLoomProcess = null;
    entityLoomRunning = false;

    if (wiped) {
      appendLog("Wipe complete. Ready for a fresh install.");
      return json({
        success: true,
        message: "All data wiped. Ready for a fresh install.",
      });
    } else {
      return json({
        success: false,
        message: "Wipe partially failed. Check the log for details.",
      });
    }
  }

  if (path === "/api/psycheros-url" && req.method === "GET") {
    const settings = loadSettings();
    const envFile = pathJoin(psycherosPackageDir(settings.installDir), ".env");
    let port = 3000;
    try {
      const env = Deno.readTextFileSync(envFile);
      const match = env.match(/^PSYCHEROS_PORT=(\d+)/m);
      if (match) port = parseInt(match[1], 10);
    } catch { /* use default */ }
    return json({ url: `http://localhost:${port}` });
  }

  if (path === "/api/start" && req.method === "POST") {
    const settings = loadSettings();
    const result = await startPsycheros(settings.installDir);
    return json(result);
  }

  if (path === "/api/stop" && req.method === "POST") {
    const result = await stopPsycheros();
    return json(result);
  }

  if (path === "/api/entity-loom/start" && req.method === "POST") {
    const settings = loadSettings();
    const result = await startEntityLoom(settings.installDir);
    return json(result);
  }

  if (path === "/api/entity-loom/stop" && req.method === "POST") {
    const result = await stopEntityLoom();
    return json(result);
  }

  // --- Serve dashboard HTML ---
  if (path === "/" || path === "/index.html") {
    return new Response(getHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Quiet browser's automatic favicon probe.
  if (path === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  return json({ error: "Not found" }, 404);
}

// --- HTML Dashboard ---

function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Psycheros Launcher</title>
<style>
  :root {
    --bg: #0f0f1a;
    --surface: #1a1a2e;
    --surface2: #252540;
    --border: #333355;
    --text: #e0e0e0;
    --text-dim: #8888aa;
    --green: #22c55e;
    --red: #ef4444;
    --blue: #3b82f6;
    --yellow: #eab308;
    --radius: 10px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 20px; }
  .container { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--red); flex-shrink: 0; }
  .status-dot.running { background: var(--green); }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 16px; }
  .card-title { font-size: 0.85rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }

  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .btn { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px 16px; border: none; border-radius: 8px; font-size: 0.95rem; font-weight: 500; cursor: pointer; transition: opacity 0.15s, transform 0.1s; }
  .btn:hover:not(:disabled) { opacity: 0.85; }
  .btn:active:not(:disabled) { transform: scale(0.98); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-install { background: var(--blue); color: #fff; }
  .btn-update { background: #6366f1; color: #fff; }
  .btn-start { background: var(--green); color: #fff; }
  .btn-stop { background: var(--red); color: #fff; }

  .spinner { width: 16px; height: 16px; border: 2px solid transparent; border-top-color: currentColor; border-radius: 50%; animation: spin 0.6s linear infinite; display: none; }
  .btn.loading .spinner { display: block; }
  .btn.loading .btn-label { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .form { display: flex; flex-direction: column; gap: 12px; }
  .field label { display: block; font-size: 0.85rem; color: var(--text-dim); margin-bottom: 4px; }
  .field input, .field select { width: 100%; padding: 10px 12px; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 0.9rem; }
  .field input:focus, .field select:focus { outline: none; border-color: var(--blue); }
  .btn-save { align-self: flex-start; padding: 8px 20px; background: var(--surface2); border: 1px solid var(--border); color: var(--text); border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
  .btn-save:hover { background: var(--border); }

  .log-panel { background: #0a0a14; border: 1px solid var(--border); border-radius: 8px; padding: 12px; font-family: "SF Mono", "Cascadia Code", "Consolas", monospace; font-size: 0.8rem; color: var(--text-dim); height: 220px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.5; }
  .log-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .btn-clear { background: none; border: 1px solid var(--border); color: var(--text-dim); border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 0.75rem; }
  .btn-clear:hover { color: var(--text); border-color: var(--text-dim); }

  .prereq-warn { background: #3b1c1c; border: 1px solid #6b2c2c; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; color: #fca5a5; font-size: 0.85rem; display: none; }

  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 20px; color: var(--text); font-size: 0.9rem; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; }

  .btn-wipe { background: transparent; border: 2px solid var(--red); color: var(--red); }
  .btn-wipe:hover:not(:disabled) { background: var(--red); color: #fff; }

  .btn-open { background: var(--green); color: #fff; }
  .btn-open:hover:not(:disabled) { opacity: 0.85; }

  .btn-tool { background: var(--surface2); border: 1px solid var(--border); color: var(--text-dim); font-size: 0.85rem; padding: 10px 14px; }
  .btn-tool:hover:not(:disabled) { background: var(--border); color: var(--text); }
  .btn-tool.running { background: #1a2e1a; border-color: #2d5a2d; color: var(--green); }
  .tool-actions { display: flex; gap: 8px; align-items: center; }
  .tool-label { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 10px; }
  .tool-label a { color: var(--blue); text-decoration: none; }
  .tool-label a:hover { text-decoration: underline; }

  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 200; align-items: center; justify-content: center; }
  .modal-overlay.active { display: flex; }
  .modal { background: var(--surface); border: 1px solid var(--red); border-radius: var(--radius); padding: 28px; max-width: 440px; width: 90%; }
  .modal h2 { color: var(--red); font-size: 1.1rem; margin-bottom: 12px; }
  .modal p { color: var(--text-dim); font-size: 0.9rem; line-height: 1.5; margin-bottom: 20px; }
  .modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
  .modal-cancel { padding: 10px 20px; background: var(--surface2); border: 1px solid var(--border); color: var(--text); border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
  .modal-cancel:hover { background: var(--border); }
  .modal-confirm { padding: 10px 20px; background: var(--red); border: none; color: #fff; border-radius: 6px; cursor: pointer; font-size: 0.9rem; font-weight: 500; }
  .modal-confirm:hover { opacity: 0.85; }
</style>
</head>
<body>
<div class="container">
  <h1><span class="status-dot" id="statusDot"></span> Psycheros Launcher</h1>

  <div class="prereq-warn" id="prereqWarn"></div>

  <div class="card">
    <div class="card-title">Actions</div>
    <div class="actions">
      <button class="btn btn-install" id="btnInstall" onclick="doInstall()">
        <div class="spinner"></div><span class="btn-label">Install</span>
      </button>
      <button class="btn btn-update" id="btnUpdate" onclick="doUpdate()">
        <div class="spinner"></div><span class="btn-label">Update</span>
      </button>
      <button class="btn btn-start" id="btnStart" onclick="doStart()">
        <div class="spinner"></div><span class="btn-label">Start</span>
      </button>
      <button class="btn btn-stop" id="btnStop" onclick="doStop()">
        <div class="spinner"></div><span class="btn-label">Stop</span>
      </button>
      <button class="btn btn-open" id="btnOpen" onclick="openPsycheros()" style="grid-column: 1 / -1; margin-top: 6px;">
        <span class="btn-label">Open Psycheros</span>
      </button>
      <div style="height: 1px; background: var(--border); margin: 10px 0; grid-column: 1 / -1;"></div>
      <button class="btn btn-wipe" id="btnWipe" onclick="showWipeModal()" style="grid-column: 1 / -1;">
        <span class="btn-label">Wipe All Data</span>
      </button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Tools</div>
    <div class="tool-label">Entity Loom — extract memories and knowledge graphs from conversations on other platforms and import them into Psycheros. <a href="https://github.com/PsycherosAI/Psycheros/tree/main/packages/entity-loom" target="_blank">Learn more</a></div>
    <div class="tool-actions">
      <button class="btn btn-tool" id="btnLoomToggle" onclick="doLoomToggle()" disabled>
        <div class="spinner"></div><span class="btn-label">Start Entity Loom</span>
      </button>
      <button class="btn btn-tool btn-open" id="btnLoomOpen" onclick="openEntityLoom()" disabled style="font-size:0.85rem; padding:10px 14px;">
        <span class="btn-label">Open Wizard</span>
      </button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Settings</div>
    <div class="form">
      <div class="field">
        <label>Install path (monorepo root)</label>
        <input type="text" id="installDir" placeholder="~/psycheros">
      </div>
      <div class="field">
        <label>Your name</label>
        <input type="text" id="userName" placeholder="You">
      </div>
      <div class="field">
        <label>Entity's name</label>
        <input type="text" id="entityName" placeholder="Assistant">
      </div>
      <div class="field">
        <label>Timezone</label>
        <input type="text" id="timezone" placeholder="America/New_York" list="tz-list">
        <datalist id="tz-list">
          <option value="America/New_York"><option value="America/Chicago"><option value="America/Denver">
          <option value="America/Los_Angeles"><option value="America/Anchorage"><option value="Pacific/Honolulu">
          <option value="Europe/London"><option value="Europe/Paris"><option value="Europe/Berlin">
          <option value="Asia/Tokyo"><option value="Asia/Shanghai"><option value="Asia/Kolkata">
          <option value="Australia/Sydney"><option value="Pacific/Auckland"><option value="UTC">
        </datalist>
      </div>
      <button class="btn-save" onclick="doSaveSettings()">Save Settings</button>
    </div>
  </div>

  <div class="card">
    <div class="log-header">
      <div class="card-title" style="margin:0">Log</div>
      <button class="btn-clear" onclick="clearLog()">Clear</button>
    </div>
    <div class="log-panel" id="logPanel"></div>
  </div>
</div>

<div class="modal-overlay" id="wipeModal">
  <div class="modal">
    <h2>Wipe All Data</h2>
    <p>This will permanently delete the entire <strong>Psycheros</strong> install directory, including all entity memory, saved settings, and generated scripts. This cannot be undone.</p>
    <div class="modal-actions">
      <button class="modal-cancel" onclick="hideWipeModal()">Cancel</button>
      <button class="modal-confirm" id="btnWipeConfirm" onclick="doWipe()">Wipe Everything</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
  let busy = false;

  function setBusy(btn, state) {
    if (state) {
      btn.classList.add("loading");
      btn.disabled = true;
      busy = true;
      setAllButtons(true);
    } else {
      btn.classList.remove("loading");
      busy = false;
      setAllButtons(false);
    }
  }

  function setAllButtons(disabled) {
    if (!busy && !disabled) disabled = false;
    document.getElementById("btnInstall").disabled = disabled;
    document.getElementById("btnUpdate").disabled = disabled;
    document.getElementById("btnStart").disabled = disabled || document.getElementById("statusDot").classList.contains("running");
    document.getElementById("btnStop").disabled = disabled || !document.getElementById("statusDot").classList.contains("running");
    document.getElementById("btnWipe").disabled = disabled || document.getElementById("statusDot").classList.contains("running");
    document.getElementById("btnOpen").disabled = disabled || !document.getElementById("statusDot").classList.contains("running");
    const loomBtn = document.getElementById("btnLoomToggle");
    document.getElementById("btnLoomOpen").disabled = disabled || !loomBtn.classList.contains("running");
  }

  function toast(msg, duration) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), duration || 3000);
  }

  function clearLog() {
    document.getElementById("logPanel").textContent = "";
  }

  async function doInstall() {
    if (busy) return;
    const btn = document.getElementById("btnInstall");
    setBusy(btn, true);
    try {
      const res = await fetch("/api/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installDir: document.getElementById("installDir").value,
          userName: document.getElementById("userName").value,
          entityName: document.getElementById("entityName").value,
          timezone: document.getElementById("timezone").value,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast(data.message);
      } else {
        toast("Error: " + data.message, 6000);
        logPanel.textContent += "[" + new Date().toLocaleTimeString() + "] ERROR: " + data.message + "\\n";
        logPanel.scrollTop = logPanel.scrollHeight;
      }
    } catch (e) { toast("Request failed — is the dashboard running?", 6000); }
    setBusy(btn, false);
  }

  async function doUpdate() {
    if (busy) return;
    const btn = document.getElementById("btnUpdate");
    setBusy(btn, true);
    try {
      const res = await fetch("/api/update", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast(data.message);
      } else {
        toast("Error: " + data.message, 6000);
        logPanel.textContent += "[" + new Date().toLocaleTimeString() + "] ERROR: " + data.message + "\\n";
        logPanel.scrollTop = logPanel.scrollHeight;
      }
    } catch (e) { toast("Request failed — is the dashboard running?", 6000); }
    setBusy(btn, false);
  }

  async function doStart() {
    if (busy) return;
    const btn = document.getElementById("btnStart");
    setBusy(btn, true);
    try {
      const res = await fetch("/api/start", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast(data.message);
      } else {
        toast("Error: " + data.message, 6000);
        logPanel.textContent += "[" + new Date().toLocaleTimeString() + "] ERROR: " + data.message + "\\n";
        logPanel.scrollTop = logPanel.scrollHeight;
      }
    } catch (e) { toast("Request failed — is the dashboard running?", 6000); }
    setBusy(btn, false);
  }

  async function openPsycheros() {
    try {
      const res = await fetch("/api/psycheros-url");
      const data = await res.json();
      window.open(data.url, "_blank");
    } catch { toast("Could not determine Psycheros URL.", 6000); }
  }

  async function doStop() {
    if (busy) return;
    const btn = document.getElementById("btnStop");
    setBusy(btn, true);
    try {
      const res = await fetch("/api/stop", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast(data.message);
      } else {
        toast("Error: " + data.message, 6000);
        logPanel.textContent += "[" + new Date().toLocaleTimeString() + "] ERROR: " + data.message + "\\n";
        logPanel.scrollTop = logPanel.scrollHeight;
      }
    } catch (e) { toast("Request failed — is the dashboard running?", 6000); }
    setBusy(btn, false);
  }

  async function doSaveSettings() {
    try {
      const res = await fetch("/api/save-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installDir: document.getElementById("installDir").value,
          userName: document.getElementById("userName").value,
          entityName: document.getElementById("entityName").value,
          timezone: document.getElementById("timezone").value,
        }),
      });
      const data = await res.json();
      toast(data.success ? "Settings saved." : "Error: " + data.message);
    } catch (e) { toast("Failed to save settings."); }
  }

  function showWipeModal() {
    document.getElementById("wipeModal").classList.add("active");
  }

  function hideWipeModal() {
    document.getElementById("wipeModal").classList.remove("active");
  }

  async function doLoomToggle() {
    if (busy) return;
    const btn = document.getElementById("btnLoomToggle");
    setBusy(btn, true);
    try {
      const loomRunning = document.getElementById("btnLoomToggle").classList.contains("running");
      const url = loomRunning ? "/api/entity-loom/stop" : "/api/entity-loom/start";
      const res = await fetch(url, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast(data.message);
      } else {
        toast("Error: " + data.message, 6000);
      }
    } catch (e) { toast("Request failed.", 6000); }
    setBusy(btn, false);
  }

  function openEntityLoom() {
    window.open("http://localhost:${ENTITY_LOOM_PORT}", "_blank");
  }

  async function doWipe() {
    hideWipeModal();
    if (busy) return;
    const btn = document.getElementById("btnWipe");
    setBusy(btn, true);
    try {
      const res = await fetch("/api/wipe", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast(data.message, 5000);
        // Reload settings (will fall back to defaults now)
        fetch("/api/settings").then(r => r.json()).then(s => {
          document.getElementById("installDir").value = s.installDir || "";
          document.getElementById("userName").value = s.userName || "You";
          document.getElementById("entityName").value = s.entityName || "Assistant";
          document.getElementById("timezone").value = s.timezone || "";
        });
      } else {
        toast("Error: " + data.message, 6000);
        logPanel.textContent += "[" + new Date().toLocaleTimeString() + "] ERROR: " + data.message + "\\n";
        logPanel.scrollTop = logPanel.scrollHeight;
      }
    } catch (e) { toast("Wipe failed — is the dashboard running?", 6000); }
    setBusy(btn, false);
  }

  // Load settings on startup
  fetch("/api/settings").then(r => r.json()).then(s => {
    document.getElementById("installDir").value = s.installDir || "";
    document.getElementById("userName").value = s.userName || "You";
    document.getElementById("entityName").value = s.entityName || "Assistant";
    document.getElementById("timezone").value = s.timezone || "";
  });

  // Check prerequisites
  fetch("/api/prerequisites").then(r => r.json()).then(p => {
    if (!p.deno) {
      const warn = document.getElementById("prereqWarn");
      warn.textContent = "Deno is not installed. This should not happen — run.ps1 / run.sh should have installed it. Try restarting.";
      warn.style.display = "block";
      document.getElementById("btnInstall").disabled = true;
    } else if (!p.git) {
      const warn = document.getElementById("prereqWarn");
      warn.textContent = "Git is not installed. Updates will download the monorepo as a tarball instead of using git pull.";
      warn.style.display = "block";
      warn.style.background = "#1c2b3b";
      warn.style.borderColor = "#2c4b6b";
      warn.style.color = "#93c5fd";
    }
  });

  // Poll status every 3 seconds
  function pollStatus() {
    fetch("/api/status").then(r => r.json()).then(s => {
      const dot = document.getElementById("statusDot");
      if (s.running) { dot.classList.add("running"); } else { dot.classList.remove("running"); }
      const loomBtn = document.getElementById("btnLoomToggle");
      const loomOpen = document.getElementById("btnLoomOpen");
      // Entity Loom is part of the monorepo — toggleable as soon as the install is present.
      loomBtn.disabled = !s.installed;
      if (s.entityLoomRunning) {
        loomBtn.classList.add("running");
        loomBtn.querySelector(".btn-label").textContent = "Stop Entity Loom";
        loomOpen.disabled = false;
      } else {
        loomBtn.classList.remove("running");
        loomBtn.querySelector(".btn-label").textContent = "Start Entity Loom";
        loomOpen.disabled = true;
      }
      setAllButtons(false);
    });
  }
  pollStatus();
  setInterval(pollStatus, 3000);

  // Connect to log stream
  const logPanel = document.getElementById("logPanel");
  const es = new EventSource("/api/logs");
  es.onmessage = (e) => {
    const { text } = JSON.parse(e.data);
    logPanel.textContent += text + "\\n";
    logPanel.scrollTop = logPanel.scrollHeight;
  };
</script>
</body>
</html>`;
}

// --- Auto-open browser ---

function openBrowser(): void {
  const url = `http://localhost:${PORT}`;
  setTimeout(() => {
    try {
      if (Deno.build.os === "darwin") {
        new Deno.Command("open", { args: [url] }).spawn();
      } else if (Deno.build.os === "windows") {
        new Deno.Command("cmd", { args: ["/c", "start", url] }).spawn();
      } else {
        new Deno.Command("xdg-open", { args: [url] }).spawn();
      }
    } catch { /* ignore */ }
  }, 1000);
}

// --- Start ---

Deno.serve({ port: PORT }, handleRequest);
appendLog(`Dashboard running at http://localhost:${PORT}`);
openBrowser();
