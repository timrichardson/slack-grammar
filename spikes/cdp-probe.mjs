#!/usr/bin/env node
// Phase 0 spike: zero-dependency CDP probe for Slack.
// Usage:
//   node cdp-probe.mjs targets                 — list CDP targets
//   node cdp-probe.mjs eval <url-substr> <js>  — evaluate JS in first matching target, print JSON result
//   node cdp-probe.mjs inject <url-substr> <js>— like eval but persists via Page.addScriptToEvaluateOnNewDocument + eval now
//   node cdp-probe.mjs on <url-substr> <event-name> <seconds> — print CDP events of given type for N seconds
import process from "node:process";

const PORT = process.env.CDP_PORT || "9222";

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from /json/list`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error("ws error: " + e.message));
  });
}

let msgId = 0;
const pending = new Map();

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function wire(ws) {
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      process.emit("cdp-event", msg);
    }
  };
}

async function pickTarget(substr) {
  const targets = await getTargets();
  const pages = targets.filter((t) => t.type === "page" || t.webSocketDebuggerUrl);
  const hit = pages.find((t) => (t.url + " " + t.title).includes(substr));
  if (!hit) {
    throw new Error(
      `no target matching '${substr}'. targets:\n` +
        pages.map((t) => `  [${t.type}] ${t.title} — ${t.url}`).join("\n")
    );
  }
  return hit;
}

const [, , cmd, ...args] = process.argv;

try {
  if (cmd === "targets") {
    for (const t of await getTargets())
      console.log(`[${t.type}] ${t.title}\n    ${t.url}`);
  } else if (cmd === "eval" || cmd === "inject") {
    const [substr, js] = args;
    const t = await pickTarget(substr);
    const ws = await connect(t.webSocketDebuggerUrl);
    wire(ws);
    if (cmd === "inject") {
      await send(ws, "Page.enable");
      await send(ws, "Page.addScriptToEvaluateOnNewDocument", { source: js });
      console.error("(script registered for future navigations)");
    }
    const r = await send(ws, "Runtime.evaluate", {
      expression: js,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails)
      console.error("exception:", JSON.stringify(r.exceptionDetails, null, 2));
    console.log(JSON.stringify(r.result.value ?? r.result.description, null, 2));
    ws.close();
  } else if (cmd === "on") {
    const [substr, eventName, seconds] = args;
    const t = await pickTarget(substr);
    const ws = await connect(t.webSocketDebuggerUrl);
    wire(ws);
    process.on("cdp-event", (m) => {
      if (m.method === eventName) console.log(JSON.stringify(m.params));
    });
    setTimeout(() => process.exit(0), Number(seconds || 5) * 1000);
  } else {
    console.log("commands: targets | eval <url-substr> <js> | inject <url-substr> <js> | on <url-substr> <event> <seconds>");
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
