//@ts-check
import { WebSocketServer, WebSocket } from "ws";
import { log } from "./Logger.js";
import Config from "./ConfigHandler.js";

const PORT = Config.RunnerWsPort;
const SECRET = Config.RunnerSecret;

/**
 * @type {Map<WebSocket, { region: string }>}
 */
const runners = new Map();

/**
 * @type {Map<string, WebSocket>}
 */
const channelRunner = new Map();

/**
 * @type {Map<string, {
 *   onMessage: (msg: string) => void,
 *   onExit: (code: number | null) => void,
 *   onError: (msg: string) => void
 * }>}
 */
const handlers = new Map();

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

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === "hello") {
      const meta = runners.get(ws);
      if (meta) meta.region = msg.region ?? "";
      log("VOICE", `Runner connected (region: ${msg.region || "any"})`);
      return;
    }

    const h = handlers.get(msg.channelId);
    if (!h) return;
    if (msg.type === "message") h.onMessage(msg.msg);
    else if (msg.type === "exit") { handlers.delete(msg.channelId); channelRunner.delete(msg.channelId); h.onExit(msg.code); }
    else if (msg.type === "error") h.onError(msg.message);
  });

  ws.on("close", () => {
    const meta = runners.get(ws);
    log("VOICE", `Runner disconnected (region: ${meta?.region || "any"})`);
    runners.delete(ws);
  });
});

/** @returns {boolean} */
export function hasRunner() {
  for (const [ws] of runners) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

/** @param {string} livekitUrl @returns {WebSocket | null} */
function selectRunner(livekitUrl) {
  const url = livekitUrl.toLowerCase();
  for (const [ws, { region }] of runners) {
    if (ws.readyState === WebSocket.OPEN && region && url.includes(region.toLowerCase())) {
      return ws;
    }
  }
  for (const [ws] of runners) {
    if (ws.readyState === WebSocket.OPEN) return ws;
  }
  return null;
}

/**
 * @param {string} channelId
 * @param {string} livekitUrl
 * @param {Record<string, string>} env
 * @param {{ onMessage: (msg: string) => void, onExit: (code: number | null) => void, onError: (msg: string) => void }} callbacks
 */
export function spawnBridge(channelId, livekitUrl, env, callbacks) {
  const runner = selectRunner(livekitUrl);
  if (!runner) {
    log("VOICE", "No runner available, cannot spawn bridge");
    return false;
  }
  handlers.set(channelId, callbacks);
  channelRunner.set(channelId, runner);
  runner.send(JSON.stringify({ type: "spawn", channelId, env }));
  return true;
}

/** @param {string} channelId */
export function killBridge(channelId) {
  const runner = channelRunner.get(channelId);
  if (runner && runner.readyState === WebSocket.OPEN) {
    runner.send(JSON.stringify({ type: "kill", channelId }));
  } else {
    handlers.delete(channelId);
    channelRunner.delete(channelId);
  }
}
