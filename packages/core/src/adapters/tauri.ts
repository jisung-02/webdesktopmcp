import { installEmbeddedBridge } from "./embedded.js";

const page = window as Window & {
  __TAURI_INTERNALS__?: { invoke(command: string, args: unknown): Promise<unknown> };
};
installEmbeddedBridge(() => {
  const native = page.__TAURI_INTERNALS__;
  if (typeof native?.invoke !== "function") return undefined;
  return message => native.invoke("plugin:webdesktopmcp|send", { message });
}, () => "main");
