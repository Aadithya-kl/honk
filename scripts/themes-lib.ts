// Shared by scripts/fetch-themes.ts and scripts/review-themes.tsx.
//
// src/themes/catalog.json says which schemes honk bundles. Writing the bundle
// copies those files into src/themes/schemes/ and generates
// src/themes/bundled.ts, which imports them, so `bun build --compile` puts them
// inside the binary.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { checkScheme, type Scheme } from "../src/themes/scheme.ts";

export const REPO = "tinted-theming/schemes";
export const THEMES_DIR = join(import.meta.dir, "..", "src", "themes");
export const CATALOG_PATH = join(THEMES_DIR, "catalog.json");

export interface Catalog {
  /** The commit of tinted-theming/schemes that the files come from. */
  commit: string;
  /** honk theme name -> path in the repo, such as "nord": "base16/nord.yaml". */
  themes: Record<string, string>;
}

export function readCatalog(): Catalog {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf-8")) as Catalog;
}

export async function writeCatalog(catalog: Catalog): Promise<void> {
  const themes = Object.fromEntries(
    Object.entries(catalog.themes).sort(([a], [b]) => a.localeCompare(b)),
  );
  await Bun.write(CATALOG_PATH, JSON.stringify({ ...catalog, themes }, null, 2) + "\n");
}

/**
 * Downloads the whole repo at `commit` once, into a cache folder outside the
 * project, and returns that folder. The files are only ever parsed as YAML.
 */
export async function downloadRepo(commit: string): Promise<string> {
  const dir = join(tmpdir(), "honk-theme-schemes", commit);
  if (existsSync(join(dir, "LICENSE"))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const url = `https://codeload.github.com/${REPO}/tar.gz/${commit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const archive = join(dir, "..", `${commit}.tar.gz`);
  await Bun.write(archive, res);
  await $`tar xzf ${archive} --strip-components=1 -C ${dir}`.quiet();
  rmSync(archive);
  return dir;
}

export function readScheme(repoDir: string, path: string): Scheme {
  const text = readFileSync(join(repoDir, path), "utf-8");
  const checked = checkScheme(Bun.YAML.parse(text));
  if (!checked.ok) throw new Error(`${path}: ${checked.problems.join("; ")}`);
  return checked.scheme;
}

export interface Candidate {
  name: string;
  path: string;
  scheme: Scheme;
}

/**
 * One scheme per name, for every name in the repo whose file passes
 * checkScheme (readable text, all slots present).
 *
 * When a name has both a base16 and a base24 file, the base24 file wins only
 * if its first 16 colors are the same as the base16 file's. Some base24 files
 * were converted from terminal palettes and have different accent colors (for
 * example base24/one-dark.yaml).
 */
export function findCandidates(repoDir: string): { candidates: Candidate[]; rejected: number } {
  const byName = new Map<string, { base16?: string; base24?: string }>();
  for (const system of ["base16", "base24"] as const) {
    for (const file of readdirSync(join(repoDir, system))) {
      if (!file.endsWith(".yaml")) continue;
      const name = file.slice(0, -5);
      const entry = byName.get(name) ?? {};
      entry[system] = `${system}/${file}`;
      byName.set(name, entry);
    }
  }

  const tryRead = (path: string | undefined) => {
    if (!path) return undefined;
    try {
      return readScheme(repoDir, path);
    } catch {
      return undefined;
    }
  };

  const candidates: Candidate[] = [];
  let rejected = 0;
  for (const [name, files] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    const b16 = tryRead(files.base16);
    const b24 = tryRead(files.base24);
    const sameFirst16 =
      b16 !== undefined &&
      b24 !== undefined &&
      Object.entries(b16.palette).every(([slot, color]) => b24.palette[slot] === color);
    if (b24 && (b16 === undefined || sameFirst16)) {
      candidates.push({ name, path: files.base24!, scheme: b24 });
    } else if (b16) {
      candidates.push({ name, path: files.base16!, scheme: b16 });
    } else {
      rejected++;
    }
  }
  return { candidates, rejected };
}

/**
 * Makes src/themes/ match the catalog: copies the scheme files, removes the
 * ones no longer listed, and writes LICENSE, SOURCE.md and bundled.ts.
 */
export async function writeBundle(repoDir: string, catalog: Catalog): Promise<void> {
  const schemesDir = join(THEMES_DIR, "schemes");
  mkdirSync(schemesDir, { recursive: true });
  const entries = Object.entries(catalog.themes).sort(([a], [b]) => a.localeCompare(b));

  // Read and check everything first, so a bad file leaves the folder as it was.
  const files = entries.map(([name, path]) => ({
    name,
    path,
    text: readFileSync(join(repoDir, path), "utf-8"),
    scheme: readScheme(repoDir, path),
  }));

  for (const file of readdirSync(schemesDir)) {
    if (file.endsWith(".yaml") && !(file.slice(0, -5) in catalog.themes)) {
      rmSync(join(schemesDir, file));
    }
  }
  for (const { name, text } of files) {
    await Bun.write(join(schemesDir, `${name}.yaml`), text);
  }
  await Bun.write(join(THEMES_DIR, "LICENSE"), readFileSync(join(repoDir, "LICENSE")));

  const ident = (name: string) => `scheme_${name.replace(/[^A-Za-z0-9]/g, "_")}`;
  await Bun.write(
    join(THEMES_DIR, "bundled.ts"),
    `// Generated by scripts/themes-lib.ts from catalog.json. Do not edit by hand.
// To change the list, run \`bun run review-themes\` or edit catalog.json and
// run \`bun run fetch-themes\`.

${files.map(({ name }) => `import ${ident(name)} from "./schemes/${name}.yaml";`).join("\n")}

/** honk theme name -> parsed scheme file. src/themes/index.ts checks each one. */
export const BUNDLED: Record<string, unknown> = {
${files.map(({ name }) => `  ${JSON.stringify(name)}: ${ident(name)},`).join("\n")}
};
`,
  );

  const rows = files.map(
    ({ name, path, scheme }) =>
      `| ${name} | ${scheme.variant} | [${path}](https://github.com/${REPO}/blob/${catalog.commit}/${path}) | ${scheme.author.replace(/\|/g, "\\|")} |`,
  );
  await Bun.write(
    join(THEMES_DIR, "SOURCE.md"),
    `# Bundled color schemes

The files in \`schemes/\` come from
[${REPO}](https://github.com/${REPO}) at commit \`${catalog.commit}\`,
under the MIT license in \`LICENSE\`.
\`scripts/themes-lib.ts\` writes this file from \`catalog.json\`. Do not edit it by hand.

| honk name | variant | source file | author |
|---|---|---|---|
${rows.join("\n")}
`,
  );
}
