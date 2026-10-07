import { WebSocketServer, WebSocket } from "ws";
import { log } from "./Logger.js";
import Config from "./ConfigHandler.js";
const PORT = Config.RunnerWsPort;
const SECRET = Config.RunnerSecret;
const runnerAvailableListeners = new Set();
const runners = new Map();
const channelRunner = new Map();
const handlers = new Map();
const pendingSpawns = new Map();
function runnerLoad(ws) {
  let n = 0;
  for (const assigned of channelRunner.values()) {
    if (assigned === ws) n += 1;
  }
  return n;
}
const wss = new WebSocketServer({ port: PORT });
wss.on("listening", () => {
  log("VOICE", `Runner server listening on :${PORT}`);
});
wss.on("connection", (ws, req) => {
  if (SECRET && req.headers["x-runner-secret"] !== SECRET) {
    ws.close(4001, "Unauthorized");
    return;
  }
  runners.set(ws, { region: "" });
  ws.on("message", data => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "hello") {
      const meta = runners.get(ws);
      if (meta) meta.region = msg.region ?? "";
      log("VOICE", `Runner connected (region: ${msg.region || "any"})`);
      for (const listener of runnerAvailableListeners) {
        listener();
      }
      return;
    }
    const h = handlers.get(msg.channelId);
    if (!h) return;
    if (msg.type === "message") h.onMessage(msg.msg);
    else if (msg.type === "exit") {
      handlers.delete(msg.channelId);
      channelRunner.delete(msg.channelId);
      pendingSpawns.delete(msg.channelId);
      h.onExit(msg.code);
    } else if (msg.type === "error") h.onError(msg.message);
    else if (msg.type === "busy") {
      const req = pendingSpawns.get(msg.channelId);
      channelRunner.delete(msg.channelId);
      if (req) {
        const next = selectRunner(req.livekitUrl, ws);
        if (next) {
          channelRunner.set(msg.channelId, next);
          next.send(JSON.stringify({ type: "spawn", channelId: msg.channelId, env: req.env }));
          return;
        }
        pendingSpawns.delete(msg.channelId);
      }
      handlers.delete(msg.channelId);
      h.onExit(8);
    }
  });
  ws.on("close", () => {
    const meta = runners.get(ws);
    log("VOICE", `Runner disconnected (region: ${meta?.region || "any"})`);
    runners.delete(ws);
    for (const [channelId, assignedRunner] of channelRunner) {
      if (assignedRunner !== ws) continue;
      channelRunner.delete(channelId);
      const h = handlers.get(channelId);
      if (!h) continue;
      handlers.delete(channelId);
      h.onExit(null);
    }
  });
});
export function hasRunner() {
  for (const [ws] of runners) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}
export function onRunnerAvailable(listener) {
  runnerAvailableListeners.add(listener);
  return () => {
    runnerAvailableListeners.delete(listener);
  };
}
function selectRunner(livekitUrl, exclude) {
  const url = String(livekitUrl ?? "").toLowerCase();
  let best = null;
  let bestLoad = Infinity;
  for (const [ws, meta] of runners) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (exclude && ws === exclude) continue;
    if (!meta.region || !url.includes(String(meta.region).toLowerCase())) continue;
    const load = runnerLoad(ws);
    if (load < bestLoad) {
      best = ws;
      bestLoad = load;
    }
  }
  if (best) return best;
  for (const [ws] of runners) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (exclude && ws === exclude) continue;
    const load = runnerLoad(ws);
    if (load < bestLoad) {
      best = ws;
      bestLoad = load;
    }
  }
  return best;
}
export function spawnBridge(channelId, livekitUrl, env, callbacks) {
  const runner = selectRunner(livekitUrl, null);
  if (!runner) {
    log("VOICE", "No runner available, cannot spawn bridge");
    return false;
  }
  handlers.set(channelId, callbacks);
  channelRunner.set(channelId, runner);
  pendingSpawns.set(channelId, { livekitUrl, env });
  runner.send(JSON.stringify({ type: "spawn", channelId, env }));
  return true;
}
export function killBridge(channelId) {
  pendingSpawns.delete(channelId);
  const runner = channelRunner.get(channelId);
  if (runner && runner.readyState === WebSocket.OPEN) {
    runner.send(JSON.stringify({ type: "kill", channelId }));
  } else {
    handlers.delete(channelId);
    channelRunner.delete(channelId);
  }
}
