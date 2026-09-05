import { installEmbeddedBridge } from "./embedded.js";

const page = window as Window & {
  runtime?: { WindowName?(): string; EventsOn?(event: string, handler: (message: unknown) => void): (() => void) | void };
  go?: { webdesktopmcp?: { Server?: { Send(frameId: string, message: unknown): Promise<unknown> } } };
};
const session = globalThis.crypto.randomUUID();
let frame = "main";
let unsubscribe: (() => void) | void;
installEmbeddedBridge(deliver => {
  const runtime = page.runtime;
  const server = page.go?.webdesktopmcp?.Server;
  if (typeof runtime?.EventsOn !== "function" || typeof server?.Send !== "function") return undefined;
  frame = runtime.WindowName?.() || "main";
  unsubscribe = runtime.EventsOn("webdesktopmcp:message", message => {
    if (!message || typeof message !== "object") return;
    const msg = message as Record<string, unknown>;
    if (typeof msg._frameId === "string" && msg._frameId !== frame) return;
    if (msg._frameId === undefined && (msg.kind === "execute" || msg.kind === "abort")) {
      const id = String(msg.invocationId ?? "");
      if (!id.startsWith("inv-" + frame + "-") && !id.startsWith("fwd-" + frame + "-")) return;
    }
    deliver(message);
  });
  return message => {
    const msg = message as Record<string, unknown>;
    return server.Send(frame, msg.kind === "register" ? { ...msg, _session: session } : msg);
  };
}, () => frame, () => { unsubscribe?.(); });
