# Console design

The console wears camelStream's design system, which camelRun inherited when
Stream retired: a quiet, square, monochrome tool, with the dithered brand only at
the edges of a first session. Stream's spec was its plan 004 (the sales site's
dither design key is its parent); this is the part the console uses.

## Tokens

`web/style.css` holds the palette: two five-step ramps, paper (light) and ink
(dark), and two accents.

- Signal blue `#5aa7ff`: status only (the `live` badge, a success check, `--chart-1`).
- Alert red `#ff4d3d`: errors and destructive actions (`--destructive`).
- Never an accent on ordinary buttons or links, and no Tailwind palette colors
  (emerald, amber, zinc…). Surfaces are tokens, without alpha washes.

`--radius` is 0: everything is square. `rounded-sm/md/lg` follow the token; bare
`rounded`, `rounded-xl` and `rounded-full` do not, so they are not used.

## Type

| Face | Role |
| --- | --- |
| Figtree | everything by default: headings, body, navigation, dialogs, labels |
| Geist Mono | code, IDs, keys, prices, usage figures |
| Silkscreen | pixel labels: eyebrows, badges, table heads, brand buttons, error codes, always through an inline style (`PIXEL_STYLE`), never a utility |
| CamelCool | display, for the three moments below only |

CamelCool is written in sentence case and draws capitals. Its apostrophes are
blank glyphs, so a `unicode-range` face in `style.css` draws them in Silkscreen;
its comma looks like its period.

Fonts are self-hosted, since the CSP allows fonts from `'self'` only;
`vite.config.ts` keeps them out of `data:` URIs.

## The three moments

1. Sign-in (`components/auth-layout.tsx`): `DitherLiquid` current behind an eyebrow and headline.
2. Get started (the home of an account with no agents): `FirstRunPanel` hero over `DitherLiquid` swell, above the
   use-case starts (a Discord bot, an agent with code).
3. First key (API keys, with none): `FirstRunPanel` over `DitherAurora` curtain.

Errors and not-found pages use `StatusPanel`: the bare curtain, the code in
Silkscreen, no CamelCool. Every other surface is a working surface: no art, no
display type.

## Art

`web/components/dither/` is consumed, not edited. The console uses Stream's
family, `DitherLiquid` and `DitherAurora`; `DitherStitch` is camelCode's and
`OrbitHero` the homepage's. Art under copy uses `TONES.ambient` and `GLOW`; bare
art uses `TONES.full`. `useArtTheme` follows the `dark` class. Motifs pause
offscreen and in hidden tabs, and paint a still frame under reduced motion.

## Components

- `PixelButton` is for brand calls to action only: sign-in, the first-run
  moments and checkout. Every other button is `Button`.
  Both share the `sm`/`default`/`lg` height scale; adjacent buttons use the same
  size. `PixelButton`'s larger `hero` size is only for sign-in and first-run panels.
- `Badge` sets Silkscreen capitals; `live` marks something running now. Data
  that must keep its case (file names, a key's last characters) is never set in
  a badge's capitals.
- `Stats` shows headline figures; tables sit in `border bg-card` frames.

## Structure

- The nav has two groups (`web/lib/nav.ts`). The workspace switcher sits above the pages it scopes: Agents,
  Definitions, Usage and Workspaces (Workspace settings when one is selected). It scopes only what the server scopes,
  and is hidden for an account with no workspaces. Below it, **Account** holds what is account-wide and never changes
  with it: Channels, Volumes, API keys, Models & keys, Billing and Settings (Telemetry and Account as link tabs).
  Then Docs and Get help. Get started shows its progress at the top until a path is done, then moves beside Docs.
- The selected workspace is `?ws=` (a workspace id or `unassigned`; absent is all) on scoped pages. Links between
  scoped pages carry it (`web/lib/router.tsx`), account pages drop it, and the browser remembers it for the way back.
  Pages read it with `useWorkspace()` (`web/lib/workspace.ts`). Every old URL keeps working; `redirectFor` replaces
  the ones whose page moved.
- Scoped lists filter by it and say so above their title (`ScopeCrumb`); a workspace is shown with `WorkspaceTag`
  and changed with `MoveMenu` (`components/workspace-ui.tsx`), never a native select. An account with no workspaces
  sees no workspace column, selection or crumb.
- Workspaces wear the gray ramp (`--chart-3`, `--chart-2`, `--chart-4`, then hatched), never a hue: signal blue keeps
  meaning "live".
- Every page header links its docs page (`PageHeader`'s `docs`, `LearnMore`) on the docs site people read
  (`web/lib/docs.ts`). An empty list says what the thing is and gives the one action to take (`EmptyState`'s `action`).
- Get started's checklists tick from the account's real state through existing endpoints (`web/lib/onboarding.ts`);
  `?start=discord` or `?start=code` on `/console/` opens a path directly, and survives sign-in.
