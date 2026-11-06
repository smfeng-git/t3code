// Launched by Codex Desktop, never by the independent supervisor.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const configFile = process.env.T3_SHARED_CODEX_CONFIG || path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
const args = process.argv.slice(2);
const serverIndex = args.indexOf("app-server");
const subcommands = ["daemon", "proxy", "generate-ts", "generate-json-schema", "help"];
// Only Desktop's main transport opts into sharing. CUA/helper app-servers
// (for example `app-server --listen stdio://`) must remain independent.
const isServer =
  serverIndex >= 0 &&
  args.includes("--analytics-default-enabled") &&
  !subcommands.includes(args[serverIndex + 1]) &&
  !args.some((arg) => ["--help", "-h", "--version", "--print-startup-config"].includes(arg));
const childEnv = { ...process.env, CODEX_APP_RUNTIME_CLI_PATH: config.binary };
delete childEnv.CODEX_CLI_PATH;
delete childEnv.CODEX_APP_SERVER_WS_URL;

async function main() {
  if (!isServer) {
    const child = spawn(config.binary, args, {
      env: childEnv,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", fail);
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }
  const endpoint = new URL(config.url);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("App-owned backend requires a loopback ws://127.0.0.1:PORT endpoint.");
  }
  if (
    process.env.CODEX_HOME &&
    path.resolve(process.env.CODEX_HOME).toLowerCase() !== path.resolve(config.home).toLowerCase()
  ) {
    throw new Error("Shared Codex home does not match the App home.");
  }
  // Fail before spawning if the old supervisor (or any other service) still owns the port.
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(Number(endpoint.port), endpoint.hostname, () => probe.close(resolve));
  });
  const serverArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--listen") {
      i++;
      continue;
    }
    if (args[i].startsWith("--listen=") || args[i] === "--stdio") continue;
    serverArgs.push(args[i]);
  }
  const child = spawn(config.binary, [...serverArgs, "--listen", config.url], {
    cwd: config.home,
    env: { ...childEnv, CODEX_HOME: config.home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // stdout must remain exclusively the App's JSONL protocol.
  child.stdout.pipe(process.stderr);
  child.stderr.pipe(process.stderr);
  let closing = false,
    connected = false,
    ws,
    retry,
    queue = [];
  const input = readline.createInterface({ input: process.stdin });
  const deadline = Date.now() + 15000;
  const runtimePath = path.join(path.dirname(configFile), "app-owned-runtime.json");
  function finish(code, message) {
    if (closing) return;
    closing = true;
    clearTimeout(retry);
    if (message) console.error(message);
    input.close();
    process.stdin.destroy();
    if (ws?.readyState === 1) ws.close();
    child.kill();
    try {
      if (JSON.parse(fs.readFileSync(runtimePath, "utf8")).adapterPid === process.pid)
        fs.unlinkSync(runtimePath);
    } catch {}
    process.exitCode = code;
    setTimeout(() => process.exit(code), 500);
  }
  child.on("error", (error) => finish(1, error.message));
  child.on("exit", (code) =>
    finish(code || 1, "App-owned backend exited; requests were not replayed."),
  );
  input.on("line", (line) => {
    if (closing) return;
    if (connected) ws.send(line);
    else if (queue.length < 100) queue.push(line);
    else finish(1, "App-owned connection queue full.");
  });
  process.stdin.on("end", () => finish(0));
  process.on("SIGTERM", () => finish(0));
  process.on("SIGINT", () => finish(0));
  function connect() {
    if (closing) return;
    const socket = new WebSocket(config.url);
    ws = socket;
    let failed = false;
    const connectionFailed = () => {
      if (failed || closing) return;
      failed = true;
      if (connected) return finish(1, "App-owned connection lost; requests were not replayed.");
      if (Date.now() >= deadline) return finish(1, "App-owned backend startup timed out.");
      retry = setTimeout(connect, 100);
    };
    socket.addEventListener("error", connectionFailed);
    socket.addEventListener("close", connectionFailed);
    socket.addEventListener("open", () => {
      if (closing || failed) {
        socket.close();
        return;
      }
      connected = true;
      fs.writeFileSync(
        runtimePath,
        JSON.stringify(
          {
            adapterPid: process.pid,
            backendPid: child.pid,
            mode: "app-owned",
            url: config.url,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      for (const line of queue) socket.send(line);
      queue = [];
    });
    socket.addEventListener("message", (event) => process.stdout.write(event.data + "\n"));
  }
  connect();
}
function fail(error) {
  console.error(error.message);
  process.exitCode = 1;
}
main().catch(fail);
