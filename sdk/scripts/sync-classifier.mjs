// Single source of truth: the classifier lives in the proxy
// (proxy/src/classifier.ts, zero-dependency and pure). This copies it into the
// SDK at build/test time so the two can never drift. Do not edit the generated
// file — edit the proxy's and re-run `npm run sync`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../proxy/src/classifier.ts");
const dest = resolve(here, "../src/classifier.ts");

const header =
  "// GENERATED — do not edit. Source of truth: proxy/src/classifier.ts\n" +
  "// Regenerate with `npm run sync`. The classifier is pure and zero-dependency,\n" +
  "// so the proxy and this SDK share one decision engine.\n\n";

mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, header + readFileSync(src, "utf8"), "utf8");
console.log(`synced classifier: ${src} -> ${dest}`);
