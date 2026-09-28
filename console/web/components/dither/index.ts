/**
 * Dither design system — public API, as the console uses it.
 *
 * The library comes from camelStream's console (itself from the sales site's
 * `app/components/dither/`), which retired and left its motif family to the
 * runtime:
 *
 *   <DitherLiquid variant="current|swell" />   sign-in art, first-agent moment
 *   <DitherAurora variant="silk|curtain" />    first-token moment, error pages
 *
 * camelCode's DitherStitch and the homepage's OrbitHero belong to other
 * products and are not shipped here.
 *
 * Shared props: theme ("dark"|"light"), seed (de-sync instances),
 * strength (TONES.ambient under copy, TONES.full for bare art), paused.
 * All components pause offscreen and render a still frame under
 * prefers-reduced-motion via useMotifLoop.
 */

export * from "./core";
export { DitherAurora, type DitherAuroraVariant, type DitherSurfaceProps } from "./aurora";
export { DitherLiquid, type DitherLiquidVariant } from "./liquid";
