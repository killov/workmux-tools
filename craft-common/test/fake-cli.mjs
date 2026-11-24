#!/usr/bin/env node
// A stand-in for `<app>-cli mcp` in the bridge tests: a stdio MCP server whose tools echo their arguments and answer
// like the Craft exports without a destination. FAKECRAFT_PIDFILE gets the pid, FAKECRAFT_MODE=exit quits at once.

import fs from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.argv[2] === "--version") {
  console.log("fakecraft-cli 0.0.0");
  process.exit(0);
}
if (process.env.FAKECRAFT_PIDFILE) fs.writeFileSync(process.env.FAKECRAFT_PIDFILE, String(process.pid));
if (process.env.FAKECRAFT_MODE === "exit") process.exit(1);

const anyArgs = { type: "object", additionalProperties: true };
const server = new Server({ name: "fakecraft", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    { name: "echo", description: "Answers its arguments as JSON.", inputSchema: anyArgs },
    { name: "export_bad", description: "Answers inline file data that is not JSON.", inputSchema: anyArgs },
    { name: "export_fmt", description: "Answers {format, dataBase64}.", inputSchema: anyArgs },
    { name: "export_png", description: "Answers {png, width} like DeckCraft's file.render.", inputSchema: anyArgs },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, (req) => {
  const args = req.params.arguments || {};
  const text = {
    echo: () => JSON.stringify(args),
    export_bad: () => '{"format":"png","dataBase64":"aGVsbG8gd29ybGQ=',
    export_fmt: () => JSON.stringify({ format: args.format, dataBase64: "aGk=" }),
    export_png: () => JSON.stringify({ png: "aGk=", width: 2 }),
  }[req.params.name];
  if (!text) return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
  return { content: [{ type: "text", text: text() }] };
});
await server.connect(new StdioServerTransport());
