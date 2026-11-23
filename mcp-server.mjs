#!/usr/bin/env node
/**
 * Standalone Local MCP Server (stdio or Streamable HTTP)
 */
import crypto from "node:crypto";
import http from "node:http";
import readline from "node:readline";
import { SERVER_INFO, handleJsonRpcMessage } from "./src/mcp-core.mjs";

function startStdioServer() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"
      );
      return;
    }
    const resp = await handleJsonRpcMessage(msg);
    if (resp !== null) {
      process.stdout.write(JSON.stringify(resp) + "\n");
    }
  });
}

function startHttpServer({ host = "127.0.0.1", port = 4546 }) {
  const sessions = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_INFO }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Not Found. Use /mcp" }));
      return;
    }
    if (req.method === "DELETE") {
      const sid = req.headers["mcp-session-id"];
      if (sid) sessions.delete(String(sid));
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let msg;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }
    let sessionId = req.headers["mcp-session-id"] ? String(req.headers["mcp-session-id"]) : "";
    if (msg.method === "initialize" && !sessionId) {
      sessionId = crypto.randomUUID();
      sessions.add(sessionId);
    }
    const resp = await handleJsonRpcMessage(msg);
    if (resp === null) {
      const headers = sessionId ? { "Mcp-Session-Id": sessionId } : {};
      res.writeHead(202, headers);
      res.end();
      return;
    }
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    res.writeHead(200, headers);
    res.end(JSON.stringify(resp));
  });

  server.listen(port, host, () => {
    console.error(`[wechat-article-cleaner-mcp] Streamable HTTP MCP listening at http://${host}:${port}/mcp`);
  });
}

const args = process.argv.slice(2);
if (args.includes("--http")) {
  const portIdx = args.indexOf("--port");
  const hostIdx = args.indexOf("--host");
  const port = portIdx >= 0 && args[portIdx + 1] ? Number(args[portIdx + 1]) : 4546;
  const host = hostIdx >= 0 && args[hostIdx + 1] ? args[hostIdx + 1] : "127.0.0.1";
  startHttpServer({ host, port });
} else {
  startStdioServer();
}
