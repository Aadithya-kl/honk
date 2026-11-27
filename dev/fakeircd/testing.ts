/** Helpers for tests that drive honk against a FakeIrcd. */

/** Waits until `check` passes, polling every 20ms. Throws after `timeoutMs`. */
export async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}
