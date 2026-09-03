import { build } from "esbuild";
import { chmodSync, writeFileSync } from "node:fs";

const result = await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  write: false,
  minify: true,
  legalComments: "none",
});

// esbuild preserves the entry's hashbang as the first line of the output.
writeFileSync("dist/cli.js", result.outputFiles[0].text);
chmodSync("dist/cli.js", 0o755);
console.log("cli: built dist/cli.js");
