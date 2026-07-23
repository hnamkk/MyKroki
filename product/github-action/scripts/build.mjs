import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  minify: true,
  legalComments: "none",
  outfile: "dist/index.cjs",
  banner: {
    js: "const __actionImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: {
    "import.meta.url": "__actionImportMetaUrl",
  },
});
