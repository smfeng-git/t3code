// @effect-diagnostics nodeBuiltinImport:off -- The HTTP fixture exercises raw SSE byte boundaries and disconnects.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import { PiWebClient } from "./piWebClient.ts";

it("shares commands and streamed events without starting or stopping a subprocess", async () => {
  const requests: string[] = [];
  let stream: NodeHttp.ServerResponse | undefined;
  const server = NodeHttp.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith("/events")) {
      stream = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = Buffer.from(
        'data: {"type":"connected"}\r\n\r\ndata: {"type":"message_end","text":"你好"}\n\n',
      );
      const split = frame.indexOf(Buffer.from("你")) + 1;
      res.write(frame.subarray(0, split));
      res.write(frame.subarray(split));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { sessionId: "shared" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const client = new PiWebClient(`http://127.0.0.1:${address.port}`, fetch);
  const controller = new AbortController();
  try {
    const events = client.events("shared", controller.signal);
    expect((await events.next()).value).toEqual({ type: "connected" });
    expect((await events.next()).value).toEqual({ type: "message_end", text: "你好" });
    expect(await client.command("shared", { type: "get_state" })).toEqual({ sessionId: "shared" });
    await events.return(undefined);
    expect(requests).toEqual(["GET /api/agent/shared/events", "POST /api/agent/shared"]);
  } finally {
    controller.abort();
    stream?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("does not retry a command whose server response failed", async () => {
  let attempts = 0;
  const server = NodeHttp.createServer((_req, res) => {
    attempts++;
    res.writeHead(502);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  try {
    const client = new PiWebClient(`http://127.0.0.1:${address.port}`, fetch);
    await expect(client.command("shared", { type: "prompt", message: "once" })).rejects.toThrow(
      "(502)",
    );
    expect(attempts).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
