// Minimální MCP klient nad streamable HTTP pro GATE a QA workflow `/resolve`.
// Záměrně bez @modelcontextprotocol/sdk: brána má měřit kontrakt z README („The contract")
// tak, jak ho uvidí WorkMux, ne přes knihovnu, která rozdíly (SSE vs. JSON, 404) schová.

/** Odpověď je buď JSON, nebo SSE se `data:` řádky — vezmi JSON-RPC odpověď s daným id. */
async function readRpc(res, id) {
  const text = await res.text();
  const type = res.headers.get("content-type") || "";
  const candidates = type.includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
    : [text];
  for (const c of candidates) {
    try {
      const msg = JSON.parse(c);
      for (const m of Array.isArray(msg) ? msg : [msg]) if (m.id === id) return m;
    } catch {
      /* jiná zpráva streamu */
    }
  }
  throw new Error(`HTTP ${res.status}, bez JSON-RPC odpovědi id=${id}: ${text.slice(0, 300)}`);
}

export function mcpClient(url, { timeoutS = 60, headers = {} } = {}) {
  const u = new URL(url);
  let sessionId = null;
  let nextId = 1;
  const post = (body, extraHeaders = {}) =>
    fetch(u, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutS * 1000),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });

  async function request(method, params = {}) {
    const id = nextId++;
    const res = await post({ jsonrpc: "2.0", id, method, params });
    sessionId = res.headers.get("mcp-session-id") || sessionId;
    return readRpc(res, id);
  }

  return {
    get sessionId() {
      return sessionId;
    },
    request,
    async initialize() {
      const init = await request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "workmux-tools-resolve", version: "1" },
      });
      if (init.result) await (await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })).text();
      return init;
    },
    listTools: () => request("tools/list", {}),
    callTool: (name, args = {}) => request("tools/call", { name, arguments: args }),
    /** Status kódu pro request s vymyšlenou session — kontrakt chce 404. */
    async unknownSessionStatus() {
      const res = await fetch(u, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutS * 1000),
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "resolve-unknown-session" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list", params: {} }),
      });
      await res.text();
      return res.status;
    },
  };
}

/** Textová podoba výsledku tools/call (obrázky a resource jako značka). */
export function resultText(result) {
  return (result?.content || [])
    .map((c) => (c.type === "text" ? c.text : c.type === "resource" ? `[resource ${c.resource?.uri}]` : `[${c.type}]`))
    .join("\n");
}
