#!/usr/bin/env bun
import { spawn, execSync, spawnSync } from "child_process";
import { createInterface } from "readline";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";

const VERSION = "0.5.5";
const DEFAULT_PORT = 5001;
const DEFAULT_OPENCODE_PORT = 5551;
const MANAGED_PORTS = [
  5001, 5002, 5003, 5173, 5174, 5175, 5176, 5552, 5553, 5554,
];

const CONFIG_DIR = path.join(os.homedir(), ".local", "run", "opencode-manager");
const ENDPOINTS_FILE = path.join(CONFIG_DIR, "endpoints.json");
const AUTH_FILE = path.join(CONFIG_DIR, "auth.json");
const CLOUDFLARED_LOG_FILE = path.join(CONFIG_DIR, "cloudflared.log");
const TUNNEL_STATE_FILE = path.join(CONFIG_DIR, "tunnel.json");
const TUNNEL_PID_FILE = path.join(CONFIG_DIR, "tunnel.pid");
const LOCK_FILE = path.join(CONFIG_DIR, "manager.lock");
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_LOG_BACKUPS = 3;

interface AuthConfig {
  username: string;
  password: string;
}

interface Endpoint {
  type: "local" | "tunnel";
  url: string;
  timestamp: string;
}

interface EndpointsConfig {
  endpoints: Endpoint[];
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function getTailscaleIp(): string | null {
  try {
    const output = execSync("tailscale ip -4 2>/dev/null", { encoding: "utf8" }).trim();
    const match = output.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function buildAuthUrl(baseUrl: string, auth: AuthConfig | null): string {
  if (!auth?.username || !auth?.password) return baseUrl;
  const urlObj = new URL(baseUrl);
  urlObj.username = auth.username;
  urlObj.password = auth.password;
  return urlObj.toString();
}

function acquireLock(): boolean {
  ensureConfigDir();
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, "utf8").trim();
      const lockedPid = parseInt(content);
      if (!isNaN(lockedPid) && isProcessRunning(lockedPid) && lockedPid !== process.pid) {
        return false;
      }
    }
    fs.writeFileSync(LOCK_FILE, process.pid.toString(), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, "utf8").trim();
      if (parseInt(content) === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch {}
}

function clearTunnelState(): void {
  try {
    if (fs.existsSync(TUNNEL_STATE_FILE)) fs.unlinkSync(TUNNEL_STATE_FILE);
    if (fs.existsSync(TUNNEL_PID_FILE)) fs.unlinkSync(TUNNEL_PID_FILE);
  } catch {}
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessDeath(pid: number, maxMs: number): boolean {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (!isProcessRunning(pid)) return true;
    spawnSync("sleep", ["0.1"]);
  }
  return !isProcessRunning(pid);
}

function killAllCloudflared(): void {
  try {
    const output = execSync('pgrep -f "cloudflared tunnel"', {
      encoding: "utf8",
    }).trim();
    if (!output) return;
    const pids = output
      .split("\n")
      .filter(Boolean)
      .map((p) => parseInt(p))
      .filter((p) => !isNaN(p));
    for (const pid of pids) {
      try {
        console.log(`   Killing orphaned cloudflared (PID ${pid})...`);
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    // Wait for all to die, then SIGKILL stragglers
    const deadline = Date.now() + 3000;
    for (const pid of pids) {
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining > 0 && !waitForProcessDeath(pid, remaining)) {
        try {
          console.log(`   Force killing cloudflared (PID ${pid})...`);
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  } catch {}
}

function cleanupStaleTunnelState(): void {
  try {
    if (!fs.existsSync(TUNNEL_STATE_FILE)) {
      // Even without state file, kill any orphaned cloudflared processes
      killAllCloudflared();
      return;
    }
    const state = JSON.parse(fs.readFileSync(TUNNEL_STATE_FILE, "utf8"));
    if (state.pid && !isProcessRunning(state.pid)) {
      console.log(
        `   Clearing stale tunnel state (PID ${state.pid} no longer running)`,
      );
      clearTunnelState();
    } else if (state.pid && isProcessRunning(state.pid)) {
      console.log(`   Stopping previous tunnel (PID ${state.pid})...`);
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {}
      if (!waitForProcessDeath(state.pid, 3000)) {
        console.log(`   Force killing previous tunnel (PID ${state.pid})...`);
        try {
          process.kill(state.pid, "SIGKILL");
        } catch {}
        waitForProcessDeath(state.pid, 1000);
      }
      clearTunnelState();
    }
    // Also kill any OTHER cloudflared processes not tracked by state file
    killAllCloudflared();
  } catch {
    killAllCloudflared();
    clearTunnelState();
  }
}

/**
 * Rotate a log file if it exceeds the maximum size.
 * Creates backups like: cloudflared.log.1, cloudflared.log.2, etc.
 */
function rotateLogFile(logPath: string): void {
  try {
    if (!fs.existsSync(logPath)) return;

    const stats = fs.statSync(logPath);
    if (stats.size < MAX_LOG_SIZE_BYTES) return;

    console.log(
      `📜 Rotating log file (${Math.round(stats.size / 1024)}KB): ${path.basename(logPath)}`,
    );

    // Remove oldest backup if it exists
    const oldestBackup = `${logPath}.${MAX_LOG_BACKUPS}`;
    if (fs.existsSync(oldestBackup)) {
      fs.unlinkSync(oldestBackup);
    }

    // Shift existing backups: .2 -> .3, .1 -> .2
    for (let i = MAX_LOG_BACKUPS - 1; i >= 1; i--) {
      const current = `${logPath}.${i}`;
      const next = `${logPath}.${i + 1}`;
      if (fs.existsSync(current)) {
        fs.renameSync(current, next);
      }
    }

    // Move current log to .1
    fs.renameSync(logPath, `${logPath}.1`);
  } catch (err) {
    console.warn("⚠️  Failed to rotate log file:", err);
  }
}

function getOrCreateAuth(): AuthConfig {
  ensureConfigDir();

  if (fs.existsSync(AUTH_FILE)) {
    try {
      const content = fs.readFileSync(AUTH_FILE, "utf8");
      const auth = JSON.parse(content) as AuthConfig;
      if (auth.username && auth.password) {
        return auth;
      }
    } catch {}
  }

  const auth: AuthConfig = {
    username: "admin",
    password: crypto.randomBytes(16).toString("base64url"),
  };

  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
  console.log(`\n🔐 Generated new credentials:`);
  console.log(`   Username: ${auth.username}`);
  console.log(`   Password: ${auth.password}`);
  console.log(`   Saved to: ${AUTH_FILE}\n`);

  return auth;
}

function updateEndpoints(localUrl: string, tunnelUrl?: string): void {
  ensureConfigDir();

  let config: EndpointsConfig = { endpoints: [] };

  if (fs.existsSync(ENDPOINTS_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(ENDPOINTS_FILE, "utf8"));
    } catch {}
  }

  const timestamp = new Date().toISOString();

  config.endpoints = config.endpoints.filter((e) => e.url !== localUrl);
  config.endpoints.push({ type: "local", url: localUrl, timestamp });

  if (tunnelUrl) {
    config.endpoints = config.endpoints.filter(
      (e) => e.type !== "tunnel" || e.url === tunnelUrl,
    );
    config.endpoints.push({ type: "tunnel", url: tunnelUrl, timestamp });
  }

  fs.writeFileSync(ENDPOINTS_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

function getPackageDir(): string {
  return path.resolve(import.meta.dir, "..");
}

function printHelp(): void {
  console.log(`
opencode-manager v${VERSION}

Usage: opencode-manager <command> [options]

Commands:
  start              Start the OpenCode Manager server
  stop [service]     Stop a service (stt, tts, opencode, tunnel, all)
  restart [service]  Restart a service (stt, tts, opencode, tunnel, all)
  status             Check status of locally running service
  install-service    Install as a user service (macOS/Linux)
  uninstall-service  Remove the user service
  logs               Show service logs
  help               Show this help message

Start Options:
  --client, -c       Connect to existing opencode server
  --tunnel, -t       Start a Cloudflare tunnel for public access
  --port, -p <port>  Backend API port (default: 5001)
  --no-auth          Disable basic authentication

Stop/Restart Options:
  --port, -p <port>  Backend API port (default: 5001)
  service            Service to stop/restart: stt, tts, opencode, tunnel, all (default: all)

Status Options:
  --port, -p <port>  Backend API port to check (default: 5001)

Service Options:
  --no-tunnel        Disable Cloudflare tunnel (tunnel enabled by default)

Note: Service runs in client mode by default, connecting to existing
opencode CLI sessions. If no opencode server is found on port 5551,
one will be started automatically.

Examples:
  opencode-manager start
  opencode-manager start --tunnel
  opencode-manager stop stt
  opencode-manager restart tts
  opencode-manager status
  opencode-manager install-service
  opencode-manager install-service --no-tunnel
`);
}

async function checkServerHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/doc`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

function isPortInUse(port: number): boolean {
  try {
    const output = execSync(`lsof -ti:${port}`, { encoding: "utf8" }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

async function waitForBackendHealth(
  port: number,
  auth: AuthConfig,
  maxSeconds: number,
): Promise<boolean> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
  };

  for (let i = 0; i < maxSeconds; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
        headers,
      });
      if (response.ok) {
        const data = (await response.json()) as { status?: string };
        if (data.status === "healthy") {
          return true;
        }
      }
    } catch {}
    if (i > 0 && i % 10 === 0) {
      console.log(`   Still waiting... (${i}s)`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function killProcessOnPort(port: number): boolean {
  try {
    const output = execSync(`lsof -ti:${port}`, { encoding: "utf8" }).trim();
    if (!output) return false;

    const pids = output
      .split("\n")
      .filter(Boolean)
      .map((p) => parseInt(p));
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`   Killed orphaned process on port ${port} (PID ${pid})`);
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    return pids.length > 0;
  } catch {
    return false;
  }
}

function cleanupManagedPorts(): void {
  let cleaned = false;
  for (const port of MANAGED_PORTS) {
    if (killProcessOnPort(port)) {
      cleaned = true;
    }
  }
  if (cleaned) {
    execSync("sleep 1");
  }
}

function getProcessCommandOnPort(port: number): string | null {
  try {
    const pidOutput = execSync(`lsof -ti:${port}`, { encoding: "utf8" }).trim();
    if (!pidOutput) return null;
    const pid = parseInt(pidOutput.split("\n")[0]);
    if (isNaN(pid)) return null;
    const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" }).trim();
    return cmd;
  } catch {
    return null;
  }
}

function isOwnedByManager(port: number): boolean {
  const cmd = getProcessCommandOnPort(port);
  if (!cmd) return false;
  return (
    cmd.includes("opencode-manager") ||
    cmd.includes("cli.ts") ||
    cmd.includes("backend/dist/index.js") ||
    cmd.includes("backend/src/index.ts")
  );
}

async function startOpenCodeServer(port: number): Promise<boolean> {
  if (isPortInUse(port)) {
    console.log(`\n⚠️  Port ${port} is already in use`);
    for (let i = 0; i < 10; i++) {
      if (await checkServerHealth(port)) {
        console.log(`✓ Existing server on port ${port} is responding`);
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(
      `   Server on port ${port} not responding, killing and restarting...`,
    );
    killProcessOnPort(port);
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n🚀 Starting opencode server on port ${port}...`);

  const serverProcess = spawn(
    "opencode",
    ["serve", "--port", port.toString(), "--hostname", "127.0.0.1"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  serverProcess.unref();

  for (let i = 0; i < 30; i++) {
    if (await checkServerHealth(port)) {
      console.log(`✓ OpenCode server started on port ${port}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.error("❌ Failed to start opencode server");
  return false;
}

async function waitForTunnelUrl(
  port: number,
  auth: AuthConfig,
  maxSeconds: number,
): Promise<{
  url: string | null;
  urlWithAuth: string | null;
}> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
  };

  for (let i = 0; i < maxSeconds; i++) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/tunnel/status`,
        { signal: AbortSignal.timeout(2000), headers },
      );
      if (response.ok) {
        const data = (await response.json()) as {
          connected?: boolean;
          url?: string;
        };
        if (data.url) {
          let urlWithAuth: string | null = null;
          if (auth.username && auth.password) {
            try {
              const parsed = new URL(data.url);
              parsed.username = auth.username;
              parsed.password = auth.password;
              urlWithAuth = parsed.toString().replace(/\/$/, "");
            } catch {}
          }
          return { url: data.url, urlWithAuth };
        }
      }
    } catch {}
    if (i > 0 && i % 10 === 0) {
      console.log(`   Still waiting for tunnel URL... (${i}s)`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { url: null, urlWithAuth: null };
}

async function startBackend(
  port: number,
  auth: AuthConfig,
  opencodePort?: number,
  tunnelEnabled?: boolean,
): Promise<ReturnType<typeof spawn>> {
  const packageDir = getPackageDir();

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: port.toString(),
    NODE_ENV: "production",
    HOST: process.env.HOST || "0.0.0.0",
    AUTH_USERNAME: auth.username,
    AUTH_PASSWORD: auth.password,
  };

  if (opencodePort) {
    env.OPENCODE_SERVER_PORT = opencodePort.toString();
    env.OPENCODE_CLIENT_MODE = "true";
  }

  if (tunnelEnabled) {
    env.TUNNEL_ENABLED = "true";
  }

  console.log(`\n🚀 Starting backend on port ${port}...`);
  if (opencodePort) {
    console.log(`   Connecting to opencode server on port ${opencodePort}`);
  }

  const backendProcess = spawn(
    "bun",
    [path.join(packageDir, "backend", "dist", "index.js")],
    {
      cwd: packageDir,
      stdio: "inherit",
      env,
    },
  );

  return backendProcess;
}

async function commandStart(args: string[]): Promise<void> {
  const hasClient = args.includes("--client") || args.includes("-c");
  const hasTunnel = args.includes("--tunnel") || args.includes("-t");
  const noAuth = args.includes("--no-auth");
  const portIdx = args.findIndex((a) => a === "--port" || a === "-p");
  const port =
    portIdx >= 0 ? parseInt(args[portIdx + 1]) || DEFAULT_PORT : DEFAULT_PORT;

  console.log("\n╔═══════════════════════════════════════╗");
  console.log("║      OpenCode Manager - Start         ║");
  console.log("╚═══════════════════════════════════════╝");

  if (!acquireLock()) {
    const lockContent = fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, "utf8").trim() : "unknown";
    console.error(`\n❌ Another opencode-manager instance is already running (PID ${lockContent})`);
    console.error("   Kill the existing process first or remove the lock file:");
    console.error(`   rm ${LOCK_FILE}`);
    process.exit(1);
  }

  ensureConfigDir();
  rotateLogFile(path.join(CONFIG_DIR, "stdout.log"));
  rotateLogFile(path.join(CONFIG_DIR, "stderr.log"));
  rotateLogFile(CLOUDFLARED_LOG_FILE);

  const auth = noAuth ? { username: "", password: "" } : getOrCreateAuth();
  let opencodePort: number | undefined;

  if (hasClient) {
    console.log(
      "\n🔍 Checking for opencode server on port",
      DEFAULT_OPENCODE_PORT,
      "...",
    );

    if (await checkServerHealth(DEFAULT_OPENCODE_PORT)) {
      console.log(`✓ Found existing server`);
      opencodePort = DEFAULT_OPENCODE_PORT;
    } else {
      console.log("   No server found, starting one...");
      if (!(await startOpenCodeServer(DEFAULT_OPENCODE_PORT))) {
        process.exit(1);
      }
      opencodePort = DEFAULT_OPENCODE_PORT;
    }
  }

  console.log("\n🧹 Cleaning up orphaned processes...");
  if (isPortInUse(port) && !isOwnedByManager(port)) {
    const cmd = getProcessCommandOnPort(port);
    console.error(`\n⚠️  Port ${port} is in use by a non-manager process:`);
    console.error(`   ${cmd}`);
    console.error("   Proceeding will kill this process.");
  }
  cleanupManagedPorts();

  const processes: ReturnType<typeof spawn>[] = [];
  const backendProcess = await startBackend(port, auth, opencodePort, hasTunnel);
  processes.push(backendProcess);

  console.log("\n⏳ Waiting for backend to be ready...");
  const backendReady = await waitForBackendHealth(port, auth, 120);
  if (!backendReady) {
    console.error("❌ Backend failed to start within timeout");
    process.exit(1);
  }
  console.log("✓ Backend is ready!");
  const localUrl = `http://localhost:${port}`;
  let tunnelUrl: string | undefined;
  let tunnelUrlWithAuth: string | undefined;

  if (hasTunnel) {
    console.log("\n⏳ Waiting for tunnel URL from backend...");
    const tunnel = await waitForTunnelUrl(port, auth, 60);
    tunnelUrl = tunnel.url || undefined;
    tunnelUrlWithAuth = tunnel.urlWithAuth || undefined;

    if (tunnel.url) {
      console.log("\n═══════════════════════════════════════");
      console.log(`🌍 Public URL: ${tunnel.url}`);
      if (tunnel.urlWithAuth) {
        console.log(`🔐 With auth:  ${tunnel.urlWithAuth}`);
      }
      console.log("═══════════════════════════════════════\n");
    } else {
      console.warn(
        "⚠️  Tunnel started but URL not available yet. Check: opencode-manager status",
      );
    }
  }

  updateEndpoints(localUrl, tunnelUrlWithAuth || tunnelUrl);

  console.log("\n📍 Endpoints:");
  console.log(`   Local: ${localUrl}`);
  if (tunnelUrlWithAuth) {
    console.log(`   Tunnel: ${tunnelUrlWithAuth}`);
  } else if (tunnelUrl) {
    console.log(`   Tunnel: ${tunnelUrl}`);
  }
  if (!noAuth) {
    console.log(`\n🔐 Auth: ${auth.username}:${auth.password}`);
  }
  console.log("\nPress Ctrl+C to stop\n");

  const cleanup = () => {
    console.log("\n\n🛑 Shutting down...");
    releaseLock();
    processes.forEach((p) => {
      try {
        p.kill("SIGTERM");
      } catch {}
    });
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await Promise.race(
    [backendProcess].map(
      (p) =>
        new Promise((_, reject) => {
          p.on("exit", (code) => {
            if (code !== 0 && code !== null) {
              reject(new Error(`Process exited with code ${code}`));
            }
          });
        }),
    ),
  );
}

function getServiceName(): string {
  return "opencode-manager";
}

function getMacOSPlistPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    "com.opencode-manager.plist",
  );
}

function getLinuxServicePath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "systemd",
    "user",
    "opencode-manager.service",
  );
}

function getFullPath(): string {
  const basePaths = [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
  ];

  const wellKnownDirs = [
    path.join(os.homedir(), ".opencode", "bin"),
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".cargo", "bin"),
  ];
  for (const dir of wellKnownDirs) {
    if (fs.existsSync(dir)) {
      basePaths.push(dir);
    }
  }

  try {
    const bunPath = execSync("which bun", { encoding: "utf8" }).trim();
    basePaths.push(path.dirname(bunPath));
  } catch {}

  try {
    const opencodePath = execSync("which opencode", {
      encoding: "utf8",
    }).trim();
    basePaths.push(path.dirname(opencodePath));
  } catch {}

  try {
    const cloudflaredPath = execSync("which cloudflared", {
      encoding: "utf8",
    }).trim();
    basePaths.push(path.dirname(cloudflaredPath));
  } catch {}

  try {
    const pythonPath = execSync("which python3", { encoding: "utf8" }).trim();
    basePaths.push(path.dirname(pythonPath));
  } catch {}

  const nvmDir = path.join(os.homedir(), ".nvm", "versions", "node");
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir);
      for (const v of versions) {
        basePaths.push(path.join(nvmDir, v, "bin"));
      }
    } catch {}
  }

  const uniquePaths = [...new Set(basePaths)];
  return uniquePaths.join(":");
}

function commandInstallService(args: string[]): void {
  const noTunnel = args.includes("--no-tunnel");
  const hasTunnel = !noTunnel;
  const platform = os.platform();

  console.log("\n🔧 Installing OpenCode Manager as a user service...\n");

  const auth = getOrCreateAuth();

  const packageDir = getPackageDir();
  const cliPath = path.join(packageDir, "bin", "cli.ts");
  const bunPath = execSync("which bun", { encoding: "utf8" }).trim();
  const fullPath = getFullPath();

  let opencodeBinFound = false;
  try {
    execSync("which opencode", { encoding: "utf8" }).trim();
    opencodeBinFound = true;
  } catch {}
  if (!opencodeBinFound) {
    const fallback = path.join(os.homedir(), ".opencode", "bin", "opencode");
    opencodeBinFound = fs.existsSync(fallback);
  }
  if (!opencodeBinFound) {
    console.warn(
      '⚠️  Warning: "opencode" binary not found in PATH or ~/.opencode/bin',
    );
    console.warn("   The service will fail to start without it.");
    console.warn(
      "   Install opencode: curl -fsSL https://opencode.ai/install | bash\n",
    );
  }

  console.log(`   PATH: ${fullPath}\n`);

  const startArgs = ["start", "--client"];
  if (hasTunnel) startArgs.push("--tunnel");

  if (platform === "darwin") {
    const plistPath = getMacOSPlistPath();
    const plistDir = path.dirname(plistPath);

    if (!fs.existsSync(plistDir)) {
      fs.mkdirSync(plistDir, { recursive: true });
    }

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opencode-manager</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${cliPath}</string>
${startArgs.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>WorkingDirectory</key>
  <string>${packageDir}</string>
  <key>StandardOutPath</key>
  <string>${path.join(CONFIG_DIR, "stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(CONFIG_DIR, "stderr.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${fullPath}</string>
    <key>HOME</key>
    <string>${os.homedir()}</string>
    <key>AUTH_USERNAME</key>
    <string>${auth.username}</string>
    <key>AUTH_PASSWORD</key>
    <string>${auth.password}</string>${
      process.env.GEMINI_API_KEY
        ? `
    <key>GEMINI_API_KEY</key>
    <string>${process.env.GEMINI_API_KEY}</string>`
        : ""
    }${
      process.env.OPENAI_API_KEY
        ? `
    <key>OPENAI_API_KEY</key>
    <string>${process.env.OPENAI_API_KEY}</string>`
        : ""
    }${
      process.env.ANTHROPIC_API_KEY
        ? `
    <key>ANTHROPIC_API_KEY</key>
    <string>${process.env.ANTHROPIC_API_KEY}</string>`
        : ""
    }${
      process.env.XAI_API_KEY
        ? `
    <key>XAI_API_KEY</key>
    <string>${process.env.XAI_API_KEY}</string>`
        : ""
    }
  </dict>
</dict>
</plist>`;

    fs.writeFileSync(plistPath, plistContent);
    console.log(`✓ Created plist: ${plistPath}`);

    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, {
        encoding: "utf8",
      });
    } catch {}

    execSync(`launchctl load "${plistPath}"`, { encoding: "utf8" });
    console.log("✓ Service loaded and started");
  } else if (platform === "linux") {
    const servicePath = getLinuxServicePath();
    const serviceDir = path.dirname(servicePath);

    if (!fs.existsSync(serviceDir)) {
      fs.mkdirSync(serviceDir, { recursive: true });
    }

    const serviceContent = `[Unit]
Description=OpenCode Manager
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} ${cliPath} ${startArgs.join(" ")}
WorkingDirectory=${packageDir}
Restart=always
RestartSec=10
Environment="PATH=${fullPath}"
Environment="HOME=${os.homedir()}"
Environment="AUTH_USERNAME=${auth.username}"
Environment="AUTH_PASSWORD=${auth.password}"

[Install]
WantedBy=default.target
`;

    fs.writeFileSync(servicePath, serviceContent);
    console.log(`✓ Created service file: ${servicePath}`);

    execSync("systemctl --user daemon-reload", { encoding: "utf8" });
    execSync("systemctl --user enable opencode-manager", { encoding: "utf8" });
    execSync("systemctl --user start opencode-manager", { encoding: "utf8" });
    console.log("✓ Service enabled and started");
  } else {
    console.error(`❌ Unsupported platform: ${platform}`);
    console.log("   Supported: macOS (darwin), Linux");
    process.exit(1);
  }

  console.log("\n✅ Installation complete!");
  console.log(`\n🔐 Credentials saved to: ${AUTH_FILE}`);
  console.log(`   Username: ${auth.username}`);
  console.log(`   Password: ${auth.password}`);
  console.log(`\n📍 Endpoints will be written to: ${ENDPOINTS_FILE}`);
  console.log("\nCommands:");
  console.log("  opencode-manager status  - Check service status");
  console.log("  opencode-manager logs    - View logs");
}

function commandUninstallService(): void {
  const platform = os.platform();

  console.log("\n🔧 Uninstalling OpenCode Manager service...\n");

  if (platform === "darwin") {
    const plistPath = getMacOSPlistPath();

    try {
      execSync(`launchctl unload "${plistPath}"`, { encoding: "utf8" });
      console.log("✓ Service stopped");
    } catch {}

    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
      console.log(`✓ Removed plist: ${plistPath}`);
    }
  } else if (platform === "linux") {
    try {
      execSync("systemctl --user stop opencode-manager", { encoding: "utf8" });
      console.log("✓ Service stopped");
    } catch {}

    try {
      execSync("systemctl --user disable opencode-manager", {
        encoding: "utf8",
      });
      console.log("✓ Service disabled");
    } catch {}

    const servicePath = getLinuxServicePath();
    if (fs.existsSync(servicePath)) {
      fs.unlinkSync(servicePath);
      console.log(`✓ Removed service file: ${servicePath}`);
    }

    execSync("systemctl --user daemon-reload", { encoding: "utf8" });
  } else {
    console.error(`❌ Unsupported platform: ${platform}`);
    process.exit(1);
  }

  console.log("\n✅ Uninstallation complete!");
}

function commandLogs(): void {
  const platform = os.platform();

  if (platform === "darwin") {
    const stdoutLog = path.join(CONFIG_DIR, "stdout.log");
    const stderrLog = path.join(CONFIG_DIR, "stderr.log");

    console.log("\n📜 OpenCode Manager Logs\n");

    if (fs.existsSync(stdoutLog)) {
      console.log("=== stdout ===");
      const result = spawnSync("tail", ["-50", stdoutLog], {
        stdio: "inherit",
      });
    }

    if (fs.existsSync(stderrLog)) {
      console.log("\n=== stderr ===");
      const result = spawnSync("tail", ["-50", stderrLog], {
        stdio: "inherit",
      });
    }
  } else if (platform === "linux") {
    spawnSync(
      "journalctl",
      ["--user", "-u", "opencode-manager", "-f", "--no-pager", "-n", "100"],
      { stdio: "inherit" },
    );
  } else {
    console.log(`❌ Unsupported platform: ${platform}`);
  }
}

interface HealthResponse {
  status: string;
  timestamp?: string;
  database?: string;
  opencode?: string;
  opencodePort?: number;
  opencodeVersion?: string;
  opencodeMinVersion?: string;
  opencodeVersionSupported?: boolean;
  telegram?: {
    running: boolean;
    sessions: number;
    allowlist: number;
  };
  error?: string;
}

interface SttStatusResponse {
  server: {
    running: boolean;
    model?: string;
    port?: number;
  };
}

interface TtsStatusResponse {
  enabled: boolean;
  configured: boolean;
  provider: string;
  coqui?: {
    running: boolean;
    device?: string;
    model?: string;
    error?: string;
  };
  chatterbox?: {
    running: boolean;
    device?: string;
    error?: string;
  };
}

interface TunnelStatusResponse {
  connected: boolean;
  url?: string;
  edgeLocation?: string;
  edgeLocationFormatted?: string;
  haConnections?: number;
  error?: string;
}

async function commandHealth(args: string[]): Promise<void> {
  const portIdx = args.findIndex((a) => a === "--port" || a === "-p");
  const port =
    portIdx >= 0 ? parseInt(args[portIdx + 1]) || DEFAULT_PORT : DEFAULT_PORT;

  // Load auth credentials
  let auth: AuthConfig | null = null;
  if (fs.existsSync(AUTH_FILE)) {
    try {
      auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as AuthConfig;
    } catch {}
  }

  const headers: Record<string, string> = {};
  if (auth?.username && auth?.password) {
    headers["Authorization"] =
      `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
  }

  const results: {
    backend: { ok: boolean; data?: HealthResponse; error?: string };
    stt: { ok: boolean; data?: SttStatusResponse; error?: string };
    tts: { ok: boolean; data?: TtsStatusResponse; error?: string };
    tunnel: { ok: boolean; data?: TunnelStatusResponse; error?: string };
  } = {
    backend: { ok: false },
    stt: { ok: false },
    tts: { ok: false },
    tunnel: { ok: false },
  };

  // Check backend health
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(5000),
      headers,
    });
    if (response.ok) {
      const data = (await response.json()) as HealthResponse;
      results.backend = { ok: data.status === "healthy", data };
    } else if (response.status === 401) {
      results.backend = { ok: false, error: "Authentication failed" };
    } else {
      results.backend = { ok: false, error: `HTTP ${response.status}` };
    }
  } catch (err) {
    results.backend = {
      ok: false,
      error: err instanceof Error ? err.message : "Connection failed",
    };
  }

  // Check STT status
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/stt/status`, {
      signal: AbortSignal.timeout(5000),
      headers,
    });
    if (response.ok) {
      const data = (await response.json()) as SttStatusResponse;
      results.stt = { ok: data.server?.running === true, data };
    } else {
      results.stt = { ok: false, error: `HTTP ${response.status}` };
    }
  } catch (err) {
    results.stt = {
      ok: false,
      error: err instanceof Error ? err.message : "Connection failed",
    };
  }

  // Check TTS status
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tts/status`, {
      signal: AbortSignal.timeout(5000),
      headers,
    });
    if (response.ok) {
      const data = (await response.json()) as TtsStatusResponse;
      // TTS is ok if configured and either provider's server is running
      const providerRunning =
        (data.provider === "coqui" && data.coqui?.running) ||
        (data.provider === "chatterbox" && data.chatterbox?.running) ||
        (data.provider === "external" && data.configured) ||
        data.provider === "builtin";
      results.tts = { ok: data.configured && providerRunning, data };
    } else {
      results.tts = { ok: false, error: `HTTP ${response.status}` };
    }
  } catch (err) {
    results.tts = {
      ok: false,
      error: err instanceof Error ? err.message : "Connection failed",
    };
  }

  // Check tunnel status
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tunnel/status`, {
      signal: AbortSignal.timeout(5000),
      headers,
    });
    if (response.ok) {
      const data = (await response.json()) as TunnelStatusResponse;
      results.tunnel = { ok: data.connected === true, data };
    } else {
      results.tunnel = { ok: false, error: `HTTP ${response.status}` };
    }
  } catch (err) {
    results.tunnel = {
      ok: false,
      error: err instanceof Error ? err.message : "Connection failed",
    };
  }

  // Build YAML output
  const backendStatus = results.backend.ok
    ? "healthy"
    : results.backend.data?.status === "degraded"
      ? "degraded"
      : "unhealthy";
  const sttStatus = results.stt.ok ? "running" : "stopped";
  const ttsStatus = results.tts.ok
    ? "running"
    : results.tts.data?.configured
      ? "stopped"
      : "not_configured";
  const tunnelStatus =
    results.tunnel.ok || results.tunnel.data?.url ? "connected" : "disconnected";

  // Overall health
  const backendDegraded = results.backend.data?.status === "degraded";
  const coreHealthy = results.backend.ok || backendDegraded;
  const allHealthy =
    results.backend.ok && results.stt.ok && results.tts.ok && results.tunnel.ok;
  const overallStatus = allHealthy
    ? "healthy"
    : coreHealthy
      ? "degraded"
      : "unhealthy";

  // YAML output
  console.log(`status: ${overallStatus}`);
  console.log(`port: ${port}`);
  const tailscaleIp = getTailscaleIp();
  if (tailscaleIp) {
    const tailscaleUrl = buildAuthUrl(`http://${tailscaleIp}:${port}`, auth);
    console.log(`tailscale_url: ${tailscaleUrl}`);
  }
  console.log("");
  console.log("backend:");
  console.log(`  status: ${backendStatus}`);
  if (results.backend.data) {
    console.log(`  database: ${results.backend.data.database || "unknown"}`);
    console.log(`  opencode: ${results.backend.data.opencode || "unknown"}`);
    if (results.backend.data.opencodeVersion) {
      console.log(
        `  opencode_version: ${results.backend.data.opencodeVersion}`,
      );
    }
  }
  if (results.backend.error) {
    console.log(`  error: ${results.backend.error}`);
  }

  console.log("");
  console.log("stt:");
  console.log(`  status: ${sttStatus}`);
  if (results.stt.data?.server) {
    console.log(`  model: ${results.stt.data.server.model || "unknown"}`);
    console.log(`  port: ${results.stt.data.server.port || "unknown"}`);
  }
  if (results.stt.error) {
    console.log(`  error: ${results.stt.error}`);
  }

  console.log("");
  console.log("tts:");
  console.log(`  status: ${ttsStatus}`);
  if (results.tts.data) {
    console.log(`  provider: ${results.tts.data.provider}`);
    if (results.tts.data.coqui?.running) {
      console.log(`  model: ${results.tts.data.coqui.model || "unknown"}`);
    }
  }
  if (results.tts.error) {
    console.log(`  error: ${results.tts.error}`);
  }

  console.log("");
  console.log("tunnel:");
  console.log(`  status: ${tunnelStatus}`);
  if (results.tunnel.data?.url) {
    // Build authenticated URL
    let tunnelUrl = results.tunnel.data.url;
    if (auth?.username && auth?.password) {
      const urlObj = new URL(tunnelUrl);
      urlObj.username = auth.username;
      urlObj.password = auth.password;
      tunnelUrl = urlObj.toString();
    }
    console.log(`  url: ${tunnelUrl}`);
    if (results.tunnel.data.edgeLocationFormatted) {
      console.log(
        `  edge_location: ${results.tunnel.data.edgeLocationFormatted}`,
      );
    }
  }
  if (!results.tunnel.ok && results.tunnel.data?.url) {
    console.log(
      "  warning: tunnel metrics not reachable; showing last known URL",
    );
  }
  if (results.tunnel.error) {
    console.log(`  error: ${results.tunnel.error}`);
  }

  // Exit code based on overall health
  process.exit(coreHealthy ? 0 : 1);
}

type ValidService = "stt" | "tts" | "opencode" | "tunnel" | "all";

function isValidService(service: string): service is ValidService {
  return ["stt", "tts", "opencode", "tunnel", "all"].includes(service);
}

interface ServiceActionResult {
  success: boolean;
  error?: string;
  results?: Array<{ service: string; success: boolean; error?: string }>;
}

async function callServiceAPI(
  port: number,
  service: ValidService,
  action: "start" | "stop" | "restart",
  auth: AuthConfig | null,
): Promise<ServiceActionResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (auth?.username && auth?.password) {
    headers["Authorization"] =
      `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/services/${service}/${action}`,
      {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(120000),
      },
    );

    if (response.status === 401) {
      return {
        success: false,
        error:
          "Authentication required. Check credentials in ~/.local/run/opencode-manager/auth.json",
      };
    }

    const data = (await response.json()) as ServiceActionResult;
    return data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { success: false, error: "Operation timed out after 2 minutes" };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function commandStop(args: string[]): Promise<void> {
  const portIdx = args.findIndex((a) => a === "--port" || a === "-p");
  const port =
    portIdx >= 0 ? parseInt(args[portIdx + 1]) || DEFAULT_PORT : DEFAULT_PORT;

  const serviceArgs =
    portIdx >= 0
      ? args.filter((_, i) => i !== portIdx && i !== portIdx + 1)
      : args;
  const service = serviceArgs[0] || "all";

  if (!isValidService(service)) {
    console.error(`Invalid service: ${service}`);
    console.error("Valid services: stt, tts, opencode, tunnel, all");
    process.exit(1);
  }

  let auth: AuthConfig | null = null;
  if (fs.existsSync(AUTH_FILE)) {
    try {
      auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as AuthConfig;
    } catch {}
  }

  console.log(`\nStopping ${service === "all" ? "all services" : service}...`);

  const result = await callServiceAPI(port, service, "stop", auth);

  if (result.success) {
    if (result.results) {
      console.log("\nResults:");
      for (const r of result.results) {
        const status = r.success ? "✓" : "✗";
        console.log(
          `  ${status} ${r.service}: ${r.success ? "stopped" : r.error || "failed"}`,
        );
      }
    } else {
      console.log(`✓ ${service} stopped successfully`);
    }
    process.exit(0);
  } else {
    console.error(`\n✗ Failed to stop ${service}: ${result.error}`);
    if (result.results) {
      console.log("\nPartial results:");
      for (const r of result.results) {
        const status = r.success ? "✓" : "✗";
        console.log(
          `  ${status} ${r.service}: ${r.success ? "stopped" : r.error || "failed"}`,
        );
      }
    }
    process.exit(1);
  }
}

async function commandRestart(args: string[]): Promise<void> {
  const portIdx = args.findIndex((a) => a === "--port" || a === "-p");
  const port =
    portIdx >= 0 ? parseInt(args[portIdx + 1]) || DEFAULT_PORT : DEFAULT_PORT;

  const serviceArgs =
    portIdx >= 0
      ? args.filter((_, i) => i !== portIdx && i !== portIdx + 1)
      : args;
  const service = serviceArgs[0] || "all";

  if (!isValidService(service)) {
    console.error(`Invalid service: ${service}`);
    console.error("Valid services: stt, tts, opencode, tunnel, all");
    process.exit(1);
  }

  let auth: AuthConfig | null = null;
  if (fs.existsSync(AUTH_FILE)) {
    try {
      auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as AuthConfig;
    } catch {}
  }

  console.log(
    `\nRestarting ${service === "all" ? "all services" : service}...`,
  );

  const result = await callServiceAPI(port, service, "restart", auth);

  if (result.success) {
    if (result.results) {
      console.log("\nResults:");
      for (const r of result.results) {
        const status = r.success ? "✓" : "✗";
        console.log(
          `  ${status} ${r.service}: ${r.success ? "restarted" : r.error || "failed"}`,
        );
      }
    } else {
      console.log(`✓ ${service} restarted successfully`);
    }
    process.exit(0);
  } else {
    console.error(`\n✗ Failed to restart ${service}: ${result.error}`);
    if (result.results) {
      console.log("\nPartial results:");
      for (const r of result.results) {
        const status = r.success ? "✓" : "✗";
        console.log(
          `  ${status} ${r.service}: ${r.success ? "restarted" : r.error || "failed"}`,
        );
      }
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const commandArgs = args.slice(1);

  switch (command) {
    case "start":
      await commandStart(commandArgs);
      break;
    case "stop":
      await commandStop(commandArgs);
      break;
    case "restart":
      await commandRestart(commandArgs);
      break;
    case "status":
      await commandHealth(commandArgs);
      break;
    case "install-service":
      commandInstallService(commandArgs);
      break;
    case "uninstall-service":
      commandUninstallService();
      break;
    case "logs":
      commandLogs();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(`opencode-manager v${VERSION}`);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
