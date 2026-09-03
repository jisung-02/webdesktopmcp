import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// 1. Bundle the main-world bootstrap as an IIFE string.
const mainWorld = await build({
  entryPoints: [path.join(here, "src/main-world.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  minify: true,
  write: false,
  legalComments: "none",
});
const source = mainWorld.outputFiles[0].text;

// 2. Bundle the preload with the bootstrap embedded as a text import.
const result = await build({
  entryPoints: [path.join(here, "src/preload.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron"],
  minify: true,
  write: false,
  legalComments: "none",
  plugins: [
    {
      name: "embed-main-world",
      setup(buildApi) {
        buildApi.onResolve({ filter: /main-world\.js\.txt$/ }, () => ({
          path: "virtual:main-world",
          namespace: "embed",
        }));
        buildApi.onLoad({ filter: /.*/, namespace: "embed" }, () => ({
          contents: source,
          loader: "text",
        }));
      },
    },
  ],
});

mkdirSync(path.join(here, "dist"), { recursive: true });
writeFileSync(path.join(here, "dist/preload.cjs"), result.outputFiles[0].text);
console.log("electron: built dist/preload.cjs (main-world bootstrap embedded)");
