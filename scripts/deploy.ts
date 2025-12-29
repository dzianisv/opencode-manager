#!/usr/bin/env bun
/**
 * Deploy opencode-manager with Basic Auth protection
 * 
 * Usage:
 *   bun run scripts/deploy.ts                    # Fresh deployment
 *   bun run scripts/deploy.ts --status           # Show status
 *   bun run scripts/deploy.ts --destroy          # Destroy resources
 *   bun run scripts/deploy.ts --update           # Update code and rebuild
 *   bun run scripts/deploy.ts --update-env       # Update environment vars
 *   bun run scripts/deploy.ts --update-auth      # Update Basic Auth password
 *   bun run scripts/deploy.ts --sync-auth        # Sync local OpenCode auth
 *   bun run scripts/deploy.ts --branch <name>    # Deploy specific branch
 *   bun run scripts/deploy.ts --repo <org/repo>  # Deploy from different repo
 * 
 * Environment variables:
 *   AUTH_USERNAME - Basic auth username (default: admin)
 *   AUTH_PASSWORD - Basic auth password (prompted if not set)
 *   AZURE_LOCATION - Azure region (default: westus2)
 *   AZURE_VM_SIZE - VM size (default: Standard_D2s_v5)
 *   GITHUB_TOKEN - GitHub token for opencode-manager (cloning private repos)
 *   DEPLOY_REPO - GitHub repo to deploy (default: dzianisv/opencode-manager)
 *   DEPLOY_BRANCH - Branch to deploy (default: main)
 * 
 * OpenCode configuration:
 *   ANTHROPIC_API_KEY - Anthropic API key for Claude models
 *   OPENAI_API_KEY - OpenAI API key
 *   GEMINI_API_KEY - Google Gemini API key
 *   OPENROUTER_API_KEY - OpenRouter API key
 *   OPENCODE_CONFIG_FILE - Path to local opencode.json config to upload
 * 
 * Auth sync (--sync-auth):
 *   Syncs both OpenCode auth and GitHub token to the remote VM:
 *   - ~/.local/share/opencode/auth.json (GitHub Copilot, Anthropic OAuth, etc.)
 *   - GITHUB_TOKEN from environment/.env
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import * as readline from "readline";
import { homedir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, "..");
const ENV_FILE = join(ROOT_DIR, ".env");
const OPENCODE_AUTH_FILE = join(homedir(), ".local/share/opencode/auth.json");

let config = {
  resourceGroup: "opencode-manager-rg",
  location: "westus2",
  vmName: "opencode-manager-vm",
  vmSize: "Standard_D2s_v5",
  adminUser: "azureuser",
  authUsername: "admin",
  authPassword: "",
  githubToken: "",
  // Deployment repo configuration
  deployRepo: "dzianisv/opencode-manager",
  deployBranch: "main",
  // OpenCode provider keys
  anthropicApiKey: "",
  openaiApiKey: "",
  geminiApiKey: "",
  openrouterApiKey: "",
  // OpenCode config file path
  opencodeConfigFile: "",
};

function exec(cmd: string, options?: { quiet?: boolean }): string {
  try {
    return execSync(cmd, { 
      encoding: "utf-8",
      stdio: options?.quiet ? "pipe" : "inherit"
    }) || "";
  } catch (e: any) {
    if (options?.quiet) return "";
    throw e;
  }
}

function execOutput(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function execJson(cmd: string): any {
  const result = execSync(cmd, { encoding: "utf-8" });
  return JSON.parse(result);
}

function loadEnv() {
  if (existsSync(ENV_FILE)) {
    const content = readFileSync(ENV_FILE, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const [, key, value] = match;
        const trimmedKey = key.trim();
        if (!process.env[trimmedKey]) {
          process.env[trimmedKey] = value.trim();
        }
      }
    }
  }
}

function initConfig() {
  config = {
    resourceGroup: process.env.AZURE_RESOURCE_GROUP || "opencode-manager-rg",
    location: process.env.AZURE_LOCATION || "westus2",
    vmName: process.env.AZURE_VM_NAME || "opencode-manager-vm",
    vmSize: process.env.AZURE_VM_SIZE || "Standard_D2s_v5",
    adminUser: "azureuser",
    authUsername: process.env.AUTH_USERNAME || "admin",
    authPassword: process.env.AUTH_PASSWORD || "",
    githubToken: process.env.GITHUB_TOKEN || "",
    // Deployment repo configuration
    deployRepo: process.env.DEPLOY_REPO || "dzianisv/opencode-manager",
    deployBranch: process.env.DEPLOY_BRANCH || "main",
    // OpenCode provider keys
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
    // OpenCode config file path
    opencodeConfigFile: process.env.OPENCODE_CONFIG_FILE || "",
  };
}

async function promptPassword(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("Enter password for Basic Auth: ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function generatePassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let password = "";
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

function checkAzureLogin(): boolean {
  try {
    execSync("az account show", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createResourceGroup() {
  console.log(`Creating resource group: ${config.resourceGroup}`);
  exec(`az group create --name ${config.resourceGroup} --location ${config.location}`, { quiet: true });
}

function createVM(): string {
  console.log(`Creating VM: ${config.vmName} (${config.vmSize})`);
  
  const cloudInit = `#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose-v2
runcmd:
  - systemctl enable docker
  - systemctl start docker
  - usermod -aG docker ${config.adminUser}
`;

  const cloudInitFile = join(ROOT_DIR, ".cloud-init.yml");
  writeFileSync(cloudInitFile, cloudInit);

  try {
    const result = execJson(`az vm create \
      --resource-group ${config.resourceGroup} \
      --name ${config.vmName} \
      --image Ubuntu2204 \
      --size ${config.vmSize} \
      --admin-username ${config.adminUser} \
      --generate-ssh-keys \
      --custom-data ${cloudInitFile} \
      --public-ip-sku Standard \
      --output json`);

    console.log(`VM created with IP: ${result.publicIpAddress}`);
    return result.publicIpAddress;
  } finally {
    unlinkSync(cloudInitFile);
  }
}

async function waitForVM(ip: string) {
  console.log("Waiting for VM to be ready...");
  const maxAttempts = 30;
  
  for (let i = 0; i < maxAttempts; i++) {
    const result = spawnSync("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=5",
      "-o", "BatchMode=yes",
      `${config.adminUser}@${ip}`,
      "echo ready"
    ], { encoding: "utf-8", stdio: "pipe" });

    if (result.status === 0) {
      console.log("\nVM is ready!");
      return;
    }
    process.stdout.write(".");
    await sleep(10000);
  }
  throw new Error("VM failed to become ready");
}

async function waitForDocker(ip: string) {
  console.log("Waiting for Docker to be ready...");
  const maxAttempts = 12;
  
  for (let i = 0; i < maxAttempts; i++) {
    const result = spawnSync("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=5",
      `${config.adminUser}@${ip}`,
      "docker --version"
    ], { encoding: "utf-8", stdio: "pipe" });

    if (result.status === 0) {
      console.log("Docker is ready!");
      return;
    }
    process.stdout.write(".");
    await sleep(5000);
  }
  throw new Error("Docker failed to start");
}

async function deployToVM(ip: string) {
  console.log("Deploying opencode-manager to VM...");
  const sshOpts = "-o StrictHostKeyChecking=no";
  const sshCmd = `ssh ${sshOpts} ${config.adminUser}@${ip}`;

  // Clone opencode-manager from configured repo and branch
  console.log(`Cloning ${config.deployRepo} (branch: ${config.deployBranch})...`);
  const repoUrl = `https://github.com/${config.deployRepo}.git`;
  const cloneCmd = `git clone -b ${config.deployBranch} ${repoUrl} opencode-manager 2>/dev/null || (cd opencode-manager && git fetch origin && git checkout ${config.deployBranch} && git pull origin ${config.deployBranch})`;
  exec(`${sshCmd} "${cloneCmd}"`, { quiet: true });

  // Pull caddy image first to generate password hash
  console.log("Generating password hash...");
  exec(`${sshCmd} "sudo docker pull caddy:2-alpine"`, { quiet: true });
  const hashCmd = `${sshCmd} "sudo docker run --rm caddy:2-alpine caddy hash-password --plaintext '${config.authPassword}'"`;
  const passwordHash = execOutput(hashCmd);

  // Create Caddyfile with basic auth (hash embedded directly to avoid $ escaping issues)
  console.log("Configuring Caddy with Basic Auth...");
  const caddyfile = `:80 {
    basicauth /* {
        ${config.authUsername} ${passwordHash}
    }
    reverse_proxy app:5003
}`;
  
  // Write Caddyfile using base64 to avoid escaping issues
  const caddyBase64 = Buffer.from(caddyfile).toString("base64");
  exec(`${sshCmd} "echo '${caddyBase64}' | base64 -d > ~/opencode-manager/Caddyfile"`, { quiet: true });

  // Create docker-compose.override.yml with Caddy
  const composeOverride = `services:
  caddy:
    image: caddy:2-alpine
    container_name: caddy-auth
    ports:
      - "80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - app
    restart: unless-stopped

  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared-tunnel
    command: tunnel --no-autoupdate --url http://caddy:80
    restart: unless-stopped
    depends_on:
      - caddy

  app:
    env_file:
      - .env
    ports: []

volumes:
  caddy_data:
  caddy_config:
`;

  const composeBase64 = Buffer.from(composeOverride).toString("base64");
  exec(`${sshCmd} "echo '${composeBase64}' | base64 -d > ~/opencode-manager/docker-compose.override.yml"`, { quiet: true });

  // Create .env file with GitHub token and OpenCode provider keys if provided
  const envLines: string[] = [];
  if (config.githubToken) {
    envLines.push(`GITHUB_TOKEN=${config.githubToken}`);
  }
  if (config.anthropicApiKey) {
    envLines.push(`ANTHROPIC_API_KEY=${config.anthropicApiKey}`);
  }
  if (config.openaiApiKey) {
    envLines.push(`OPENAI_API_KEY=${config.openaiApiKey}`);
  }
  if (config.geminiApiKey) {
    envLines.push(`GEMINI_API_KEY=${config.geminiApiKey}`);
  }
  if (config.openrouterApiKey) {
    envLines.push(`OPENROUTER_API_KEY=${config.openrouterApiKey}`);
  }

  if (envLines.length > 0) {
    console.log("Configuring environment variables...");
    const envContent = envLines.join("\n");
    const envBase64 = Buffer.from(envContent).toString("base64");
    exec(`${sshCmd} "echo '${envBase64}' | base64 -d > ~/opencode-manager/.env"`, { quiet: true });
  }

  // Upload OpenCode config file if specified
  if (config.opencodeConfigFile) {
    await uploadOpencodeConfig(ip);
  }

  // Sync OpenCode auth from local machine
  await uploadOpencodeAuth(ip);

  // Build and start
  console.log("Starting Docker containers (this may take a few minutes)...");
  exec(`${sshCmd} "cd ~/opencode-manager && sudo docker compose up -d --build"`, { quiet: false });

  console.log("Deployment complete!");
}

function getVMIP(): string | null {
  try {
    const result = execSync(`az vm list-ip-addresses \
      --resource-group ${config.resourceGroup} \
      --name ${config.vmName} \
      --query "[0].virtualMachine.network.publicIpAddresses[0].ipAddress" \
      --output tsv`, { encoding: "utf-8" });
    return result.trim() || null;
  } catch {
    return null;
  }
}

function destroyResources() {
  console.log(`Destroying resource group: ${config.resourceGroup}`);
  exec(`az group delete --name ${config.resourceGroup} --yes --no-wait`);
  console.log("Destruction initiated (running in background)");
}

async function showStatus() {
  const ip = getVMIP();
  if (!ip) {
    console.log("No VM found");
    return;
  }

  console.log(`\nVM IP: ${ip}`);
  console.log(`SSH: ssh ${config.adminUser}@${ip}`);
  
  try {
    console.log("\nContainer status:");
    exec(`ssh -o StrictHostKeyChecking=no ${config.adminUser}@${ip} "sudo docker ps --format 'table {{.Names}}\t{{.Status}}'"`, { quiet: false });

    const tunnelLogs = execOutput(
      `ssh -o StrictHostKeyChecking=no ${config.adminUser}@${ip} "sudo docker logs cloudflared-tunnel 2>&1"`
    );
    
    const urlMatch = tunnelLogs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (urlMatch) {
      console.log(`\nTunnel URL: ${urlMatch[0]}`);
      console.log(`Username: ${config.authUsername}`);
      console.log(`(Password was set during deployment)`);
    }

    console.log("\nOpenCode Manager logs (last 5 lines):");
    exec(`ssh -o StrictHostKeyChecking=no ${config.adminUser}@${ip} "sudo docker logs opencode-manager 2>&1 | tail -5"`, { quiet: false });
  } catch {
    console.log("Could not fetch status");
  }
}

async function redeployAuth(ip: string) {
  console.log("Updating authentication...");
  const sshOpts = "-o StrictHostKeyChecking=no";
  const sshCmd = `ssh ${sshOpts} ${config.adminUser}@${ip}`;

  // Generate new password hash
  const hashCmd = `${sshCmd} "sudo docker run --rm caddy:2-alpine caddy hash-password --plaintext '${config.authPassword}'"`;
  const passwordHash = execOutput(hashCmd);
  
  // Update Caddyfile with new hash
  const caddyfile = `:80 {
    basicauth /* {
        ${config.authUsername} ${passwordHash}
    }
    reverse_proxy app:5003
}`;
  
  const caddyBase64 = Buffer.from(caddyfile).toString("base64");
  exec(`${sshCmd} "echo '${caddyBase64}' | base64 -d > ~/opencode-manager/Caddyfile"`, { quiet: true });
  
  // Restart caddy
  exec(`${sshCmd} "cd ~/opencode-manager && sudo docker compose restart caddy"`, { quiet: true });
  console.log("Authentication updated!");
}

async function updateEnv(ip: string) {
  console.log("Updating environment configuration...");
  const sshOpts = "-o StrictHostKeyChecking=no";
  const sshCmd = `ssh ${sshOpts} ${config.adminUser}@${ip}`;

  // Build env content
  const envLines: string[] = [];
  if (config.githubToken) {
    envLines.push(`GITHUB_TOKEN=${config.githubToken}`);
  }
  if (config.anthropicApiKey) {
    envLines.push(`ANTHROPIC_API_KEY=${config.anthropicApiKey}`);
  }
  if (config.openaiApiKey) {
    envLines.push(`OPENAI_API_KEY=${config.openaiApiKey}`);
  }
  if (config.geminiApiKey) {
    envLines.push(`GEMINI_API_KEY=${config.geminiApiKey}`);
  }
  if (config.openrouterApiKey) {
    envLines.push(`OPENROUTER_API_KEY=${config.openrouterApiKey}`);
  }

  if (envLines.length === 0 && !config.opencodeConfigFile) {
    console.log("No environment variables or config to update.");
    console.log("Set GITHUB_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, etc. in your environment or .env file.");
    return;
  }

  if (envLines.length > 0) {
    const envContent = envLines.join("\n");
    const envBase64 = Buffer.from(envContent).toString("base64");
    exec(`${sshCmd} "echo '${envBase64}' | base64 -d > ~/opencode-manager/.env"`, { quiet: true });
    console.log("Environment file updated with: " + envLines.map(l => l.split("=")[0]).join(", "));
  }

  // Upload OpenCode config file if specified
  if (config.opencodeConfigFile) {
    await uploadOpencodeConfig(ip);
  }

  // Restart the app container to pick up new env
  console.log("Restarting app container...");
  exec(`${sshCmd} "cd ~/opencode-manager && sudo docker compose up -d app"`, { quiet: true });
  console.log("Environment updated and app restarted!");
}

async function uploadOpencodeConfig(ip: string) {
  const sshOpts = "-o StrictHostKeyChecking=no";
  const sshCmd = `ssh ${sshOpts} ${config.adminUser}@${ip}`;

  if (!config.opencodeConfigFile) return;

  const configPath = join(ROOT_DIR, config.opencodeConfigFile);
  if (!existsSync(configPath)) {
    console.log(`Warning: OpenCode config file not found: ${configPath}`);
    return;
  }

  console.log("Uploading OpenCode config...");
  const configContent = readFileSync(configPath, "utf-8");
  const configBase64 = Buffer.from(configContent).toString("base64");
  
  // Create the opencode config directory and upload config
  // The config goes to /workspace/.config/opencode/ which is the global config location inside the container
  exec(`${sshCmd} "mkdir -p ~/opencode-manager/workspace/.config/opencode"`, { quiet: true });
  exec(`${sshCmd} "echo '${configBase64}' | base64 -d > ~/opencode-manager/workspace/.config/opencode/opencode.json"`, { quiet: true });
  console.log("OpenCode config uploaded to workspace/.config/opencode/opencode.json");
}

async function uploadOpencodeAuth(ip: string) {
  const sshOpts = "-o StrictHostKeyChecking=no";
  const sshCmd = `ssh ${sshOpts} ${config.adminUser}@${ip}`;

  if (!existsSync(OPENCODE_AUTH_FILE)) {
    console.log("No local OpenCode auth.json found at ~/.local/share/opencode/auth.json");
    console.log("Run 'opencode' and use /connect to authenticate with providers first.");
    return false;
  }

  console.log("Uploading OpenCode authentication...");
  const authContent = readFileSync(OPENCODE_AUTH_FILE, "utf-8");
  const authBase64 = Buffer.from(authContent).toString("base64");
  
  // Copy auth.json directly into the running container's workspace volume
  exec(`${sshCmd} "sudo docker exec opencode-manager mkdir -p /workspace/.local/share/opencode"`, { quiet: true });
  exec(`${sshCmd} "echo '${authBase64}' | base64 -d | sudo docker exec -i opencode-manager tee /workspace/.local/share/opencode/auth.json > /dev/null"`, { quiet: true });
  exec(`${sshCmd} "sudo docker exec opencode-manager chmod 600 /workspace/.local/share/opencode/auth.json"`, { quiet: true });
  console.log("OpenCode auth uploaded (GitHub Copilot, Anthropic OAuth, etc.)");
  return true;
}

async function updateCode(ip: string) {
  console.log(`Updating code on VM to ${config.deployRepo} (branch: ${config.deployBranch})...`);
  const sshOpts = "-o StrictHostKeyChecking=no";
  const sshCmd = `ssh ${sshOpts} ${config.adminUser}@${ip}`;

  // Fetch and checkout the specified branch
  const updateCmd = `cd ~/opencode-manager && git fetch origin && git checkout ${config.deployBranch} && git pull origin ${config.deployBranch}`;
  exec(`${sshCmd} "${updateCmd}"`, { quiet: false });

  // Rebuild and restart containers
  console.log("Rebuilding and restarting containers...");
  exec(`${sshCmd} "cd ~/opencode-manager && sudo docker compose up -d --build"`, { quiet: false });

  console.log("\nCode updated and containers restarted!");
}

async function syncAuth(ip: string) {
  console.log("Syncing authentication to remote VM...\n");
  const sshOpts = "-o StrictHostKeyChecking=no";
  const sshCmd = `ssh ${sshOpts} ${config.adminUser}@${ip}`;

  let hasChanges = false;

  // 1. Sync OpenCode auth.json directly into the container
  const authUploaded = await uploadOpencodeAuth(ip);
  if (authUploaded) hasChanges = true;

  // 2. Sync GitHub token to opencode-manager settings API and .env
  if (config.githubToken) {
    console.log("Syncing GitHub token...");
    
    // Update .env file for container environment
    let existingEnv = "";
    try {
      existingEnv = execOutput(`${sshCmd} "cat ~/opencode-manager/.env 2>/dev/null || echo ''"`);
    } catch {}

    const envLines = existingEnv.split("\n").filter(line => line.trim() && !line.startsWith("GITHUB_TOKEN="));
    envLines.push(`GITHUB_TOKEN=${config.githubToken}`);
    
    const envContent = envLines.join("\n");
    const envBase64 = Buffer.from(envContent).toString("base64");
    exec(`${sshCmd} "echo '${envBase64}' | base64 -d > ~/opencode-manager/.env"`, { quiet: true });
    
    // Also set gitToken in opencode-manager settings via API
    // Wait for container to be healthy first
    console.log("Waiting for API to be ready...");
    await sleep(3000);
    
    try {
      const settingsPayload = JSON.stringify({ preferences: { gitToken: config.githubToken } });
      exec(`${sshCmd} "curl -s -X PATCH http://localhost:5003/api/settings -H 'Content-Type: application/json' -d '${settingsPayload}'"`, { quiet: true });
      console.log("GitHub token synced to opencode-manager settings");
    } catch (e) {
      console.log("Warning: Could not update settings API (container may still be starting)");
    }
    
    hasChanges = true;
  } else {
    console.log("No GITHUB_TOKEN set in environment or .env file (skipping)");
  }

  if (hasChanges) {
    console.log("\nRestarting app container to pick up changes...");
    exec(`${sshCmd} "cd ~/opencode-manager && sudo docker compose restart app"`, { quiet: true });
    
    // Set gitToken via API after restart
    if (config.githubToken) {
      console.log("Waiting for container to restart...");
      await sleep(5000);
      try {
        const settingsPayload = JSON.stringify({ preferences: { gitToken: config.githubToken } });
        exec(`${sshCmd} "curl -s -X PATCH http://localhost:5003/api/settings -H 'Content-Type: application/json' -d '${settingsPayload}'"`, { quiet: true });
        console.log("GitHub token configured in opencode-manager");
      } catch (e) {
        console.log("Warning: Could not update settings API after restart");
      }
    }
    
    console.log("Auth synced and app restarted!");
  } else {
    console.log("\nNo authentication to sync.");
  }
}

async function main() {
  loadEnv();
  initConfig();

  const args = process.argv.slice(2);
  
  // Parse --branch argument
  const branchIndex = args.indexOf("--branch");
  if (branchIndex !== -1 && args[branchIndex + 1]) {
    config.deployBranch = args[branchIndex + 1];
  }
  
  // Parse --repo argument
  const repoIndex = args.indexOf("--repo");
  if (repoIndex !== -1 && args[repoIndex + 1]) {
    config.deployRepo = args[repoIndex + 1];
  }
  
  if (args.includes("--destroy")) {
    destroyResources();
    return;
  }

  if (args.includes("--status")) {
    await showStatus();
    return;
  }

  // Check Azure login
  if (!checkAzureLogin()) {
    console.error("Not logged into Azure. Run: az login");
    process.exit(1);
  }

  // Check if VM exists for update commands (these don't need password)
  const existingIP = getVMIP();
  
  if (existingIP && args.includes("--sync-auth")) {
    await syncAuth(existingIP);
    return;
  }

  if (existingIP && args.includes("--update-env")) {
    await updateEnv(existingIP);
    return;
  }

  if (existingIP && args.includes("--update")) {
    await updateCode(existingIP);
    return;
  }

  if (existingIP && args.includes("--update-auth")) {
    // This one needs password for updating Basic Auth
    if (!config.authPassword) {
      config.authPassword = await promptPassword();
      if (!config.authPassword) {
        console.error("Password is required for --update-auth");
        process.exit(1);
      }
    }
    await redeployAuth(existingIP);
    return;
  }

  // Get or prompt for password (only for fresh deployment)
  if (!config.authPassword) {
    const useGenerated = !process.stdin.isTTY;
    if (useGenerated) {
      config.authPassword = generatePassword();
      console.log(`Generated password: ${config.authPassword}`);
    } else {
      config.authPassword = await promptPassword();
      if (!config.authPassword) {
        config.authPassword = generatePassword();
        console.log(`Generated password: ${config.authPassword}`);
      }
    }
  }

  console.log("\n=== OpenCode Manager Deployment ===\n");
  console.log(`Username: ${config.authUsername}`);
  console.log(`Password: ${config.authPassword}`);
  console.log("");

  createResourceGroup();
  const ip = createVM();
  await waitForVM(ip);
  await waitForDocker(ip);
  await deployToVM(ip);

  // Wait for tunnel
  console.log("\nWaiting for tunnel...");
  await sleep(15000);

  console.log("\n=== Deployment Summary ===");
  console.log(`VM IP: ${ip}`);
  console.log(`SSH: ssh ${config.adminUser}@${ip}`);
  
  const tunnelLogs = execOutput(
    `ssh -o StrictHostKeyChecking=no ${config.adminUser}@${ip} "sudo docker logs cloudflared-tunnel 2>&1"`
  );
  const urlMatch = tunnelLogs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (urlMatch) {
    console.log(`\nTunnel URL: ${urlMatch[0]}`);
  }
  
  console.log(`\nCredentials:`);
  console.log(`  Username: ${config.authUsername}`);
  console.log(`  Password: ${config.authPassword}`);
  
  console.log(`\nCommands:`);
  console.log(`  Status:  bun run scripts/deploy.ts --status`);
  console.log(`  Destroy: bun run scripts/deploy.ts --destroy`);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
