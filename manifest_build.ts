// Build-time manifest composition. Kept pure (no fs) so the overlay logic —
// which decides, among other things, which background the Firefox artifact
// ships — is unit-tested. `makeManifestFile` in buildUtils.ts wires it to disk.
//
// Two manifest families from one source:
//   * chromium — manifest.json as written. Chrome, Brave and Opera all run it:
//     Brave and Opera are Chromium and read the same keys (Opera honours
//     `minimum_chrome_version`), so they share one package and need no keys of
//     their own.
//   * firefox — manifest.json with the firefox.json overlay applied and the
//     Chrome-only keys removed. Firefox needs its own because its MV3 background
//     is an event page (`background.scripts`, no `service_worker`), it requires
//     the `browser_specific_settings.gecko` block, and AMO's linter flags
//     `minimum_chrome_version`.

export type BrowserTarget = 'chrome' | 'brave' | 'opera' | 'firefox';
export type ManifestFamily = 'chromium' | 'firefox';

export const BROWSER_TARGETS: readonly BrowserTarget[] = [
  'chrome',
  'brave',
  'opera',
  'firefox',
];

export function manifestFamily(target: BrowserTarget): ManifestFamily {
  return target === 'firefox' ? 'firefox' : 'chromium';
}

// The Chromium manifest is the base manifest.json, deep-copied so a caller can
// never mutate the source object through the result.
export function chromiumManifest(
  base: Record<string, unknown>
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
}

// The Firefox manifest is the base manifest.json with the firefox.json overlay
// applied and Chrome-only keys removed.
export function firefoxManifest(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  // A shallow overlay: a key present in firefox.json REPLACES the base key
  // wholesale. This is deliberate — the `background` override is the Firefox
  // event-page form ({ scripts }), which must fully supplant the Chrome
  // service_worker form rather than partially merge with it. Overrides therefore
  // declare the complete object they want.
  const merged: Record<string, unknown> = { ...base, ...override };
  // minimum_chrome_version is Chrome-only; Firefox ignores it and AMO lint flags
  // it. Firefox's own floor is browser_specific_settings.gecko.strict_min_version
  // in firefox.json.
  delete merged.minimum_chrome_version;
  return merged;
}

// The manifest one browser target ships.
export function manifestFor(
  target: BrowserTarget,
  base: Record<string, unknown>,
  firefoxOverlay: Record<string, unknown>
): Record<string, unknown> {
  return manifestFamily(target) === 'firefox'
    ? firefoxManifest(base, firefoxOverlay)
    : chromiumManifest(base);
}
