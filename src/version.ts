// The release build (scripts/release.ts) replaces these two names with string
// literals through `bun build --define`. When honk runs from source, nothing
// replaces them, and `typeof` reads an undeclared name without throwing.
declare const __HONK_VERSION__: string;
declare const __HONK_TARGET__: string;

/** The release tag this binary was built from, such as "v0.2.0", or "dev" when run from source. */
export const VERSION: string =
  typeof __HONK_VERSION__ === "string" ? __HONK_VERSION__ : "dev";

/**
 * The release asset this binary came from, without the "honk-" prefix, such as
 * "linux-x64-musl", or undefined when run from source.
 */
export const TARGET: string | undefined =
  typeof __HONK_TARGET__ === "string" ? __HONK_TARGET__ : undefined;

/** The line `honk --version` prints, such as "honk v0.2.0 (darwin-arm64)". */
export function versionLine(): string {
  return TARGET ? `honk ${VERSION} (${TARGET})` : `honk ${VERSION}`;
}
