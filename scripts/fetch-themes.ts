// Makes src/themes/ match src/themes/catalog.json: downloads tinted-theming/schemes
// at the catalog's commit, then copies the listed scheme files and generates
// src/themes/bundled.ts. Run it by hand after you edit catalog.json:
//
//   bun run fetch-themes
//
// To pick themes by looking at them in honk, run `bun run review-themes` instead.
// The build never runs either script: the files it writes are committed.

import { downloadRepo, readCatalog, writeBundle } from "./themes-lib.ts";

const catalog = readCatalog();
const repoDir = await downloadRepo(catalog.commit);
await writeBundle(repoDir, catalog);
console.log(`wrote ${Object.keys(catalog.themes).length} schemes`);
