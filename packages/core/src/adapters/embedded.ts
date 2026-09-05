import { bootstrapWebDesktopMcp, type BootstrapHandle } from "../bootstrap.js";
import type { HostBridgeLike } from "../types.js";

type Sender = (message: unknown) => unknown;
export interface EmbeddedWindow extends Window {
  __webDesktopMcpHost?: HostBridgeLike & { _deliver(message: unknown): void };
}

export function installEmbeddedBridge(
  connect: (deliver: (message: unknown) => void) => Sender | undefined,
  frameId: () => string,
  disconnect: () => void = () => {},
): void {
  const page = window as EmbeddedWindow;
  if (window.top !== window || page.__webDesktopMcpHost) return;
  const subscribers = new Set<(message: unknown) => void>();
  const queue: unknown[] = [];
  let sender: Sender | undefined;
  let handle: BootstrapHandle | null = null;
  let closed = false;
  let disposing = false;
  let attempts = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (closed || disposing) return;
    disposing = true;
    clearTimeout(retry);
    handle?.dispose();
    disconnect();
    queue.length = 0;
    subscribers.clear();
    closed = true;
    disposing = false;
    window.removeEventListener("pagehide", stop);
  };
  const fail = (error: unknown) => {
    sender = undefined;
    console.error("[webdesktopmcp] Native transport failed.", error);
    stop();
  };
  const dispatch = (message: unknown) => {
    try {
      Promise.resolve(sender!(message)).then((ack) => {
        if (ack && typeof ack === "object" && "ok" in ack && ack.ok === false) {
          fail(new Error("Native transport rejected the message."));
        }
      }, fail);
    } catch (error) { fail(error); }
  };
  const host: NonNullable<EmbeddedWindow["__webDesktopMcpHost"]> = {
    send(message) {
      if (closed) throw new DOMException("Native transport is closed.", "InvalidStateError");
      if (sender) dispatch(message);
      else if (!disposing) {
        if (queue.length >= 1024) { fail(new Error("Native transport queue is full.")); return; }
        queue.push(message);
      }
    },
    onMessage(handler) {
      subscribers.add(handler);
      return () => { subscribers.delete(handler); };
    },
    _deliver(message) {
      for (const handler of [...subscribers]) handler(message);
    },
  };
  page.__webDesktopMcpHost = host;
  const tryConnect = () => {
    if (closed) return;
    try { sender = connect(host._deliver); } catch (error) { fail(error); return; }
    if (sender) {
      for (const message of queue.splice(0)) {
        if (!sender) break;
        dispatch(message);
      }
    } else if (++attempts >= 100) {
      fail(new Error("Native transport did not become ready within 5 seconds."));
    } else retry = setTimeout(tryConnect, 50);
  };
  tryConnect();
  if (closed) return;
  handle = bootstrapWebDesktopMcp({
    bridge: host, frameId: frameId(), appName: "desktop", appVersion: "0.0.0",
    force: true, native: "auto",
  });
  window.addEventListener("pagehide", stop, { once: true });
}
