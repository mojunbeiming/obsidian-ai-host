/**
 * Icons that cannot fail to render.
 *
 * `setIcon(name)` is typed as `IconName`, which Obsidian declares as `string` --
 * so a misspelled or no-longer-bundled name is **not a type error**. It renders
 * as an empty element: the button is still there, still clickable, and blank.
 * That is a particularly bad failure for an icon-only control, because there is
 * nothing left on screen to say what it does.
 *
 * `addIcon(name, svg)` is public API and overrides a name, so the fix is to
 * claim our own names for the few icons we need and always have something to
 * draw. The names are prefixed `sfc-` so they cannot collide with a built-in, and
 * every one of these also has a real fallback chain for the case where Obsidian
 * later ships the name we originally wanted.
 *
 * The SVGs are copied from the Lucide set Obsidian itself uses (ISC licensed),
 * so the shapes match the rest of the interface.
 *
 * ## The grid (this cost a shipped release)
 *
 * `addIcon` does **not** hand the markup straight to the DOM. Obsidian builds an
 * `<svg>` with `viewBox="0 0 100 100"` and puts the markup inside it, so a
 * fragment drawn on Lucide's 24-unit grid renders at 24% of the box, in the
 * top-left corner -- a single dot in the ribbon. The first version of this file
 * shipped exactly that, and the symptom was reported as "the sidebar icon is
 * just a dot", not as "the icon is the wrong size".
 *
 * So the table below stays on the 24 grid (it is Lucide data and must stay
 * comparable with it), and `registerableSvg` rescales at registration time.
 */

export interface FallbackIcon {
  /** A short, stable name we register ourselves. */
  readonly name: string;
  /** Lucide names to try first, best first. */
  readonly preferred: readonly string[];
  /** The drawing, used when none of the preferred names resolve. */
  readonly svg: string;
}

const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

export const FALLBACK_ICONS: readonly FallbackIcon[] = [
  {
    name: "sfc-pin-off",
    // No `pin` alias here, deliberately: `pin` is its own family, and sharing it
    // would make "pinned" and "not pinned" draw the same glyph. The svg below is
    // the crossed-out pin, used when `pin-off` itself is absent.
    preferred: ["pin-off"],
    svg: `<g ${STROKE}><line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14"/><path d="M15 9.34V6a2 2 0 0 0-2-2h-2"/></g>`,
  },
  {
    name: "sfc-wifi-off",
    preferred: ["wifi-off", "cloud-off", "wifi"],
    svg: `<g ${STROKE}><line x1="2" y1="2" x2="22" y2="22"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 12.55a10 10 0 0 1 5.17-2.39"/><line x1="12" y1="20" x2="12.01" y2="20"/></g>`,
  },
  {
    name: "sfc-alert-triangle",
    preferred: ["alert-triangle", "triangle-alert", "alert-circle"],
    svg: `<g ${STROKE}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></g>`,
  },
  {
    name: "sfc-calendar",
    preferred: ["calendar", "calendar-days"],
    svg: `<g ${STROKE}><rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></g>`,
  },
  {
    name: "sfc-pin",
    preferred: ["pin", "map-pin"],
    svg: `<g ${STROKE}><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></g>`,
  },
  {
    /**
     * The flashcards entry point.
     *
     * Two things learned the hard way:
     *
     * 1. **It must be our own name.** `layers` was used here directly and happens
     *    to resolve in current Obsidian -- which is exactly the bet this module
     *    exists to avoid. Lucide renames icons between versions, and a name that
     *    stops resolving renders an **empty** ribbon button, so the user
     *    concludes the plugin has no entry point at all.
     * 2. **It must be legible at 24px in a column of a dozen others.** The first
     *    version was an outline of a card behind a card: correct, and invisible
     *    next to `check-square` and `calendar-days`, which is what "not
     *    noticeable" meant. Filled shapes read at ribbon size where thin strokes
     *    do not, so this is a filled stack -- the top card solid, the ones behind
     *    it as offsets.
     */
    name: "sfc-cards",
    preferred: ["gallery-vertical-end", "layers"],
    svg: `<g><path fill="currentColor" d="M8 2h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M3 5v15a2 2 0 0 0 2 2h11"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M10 8h7M10 12h7"/></g>`,
  },
];

/** Obsidian's icon box is 100 units; Lucide draws on 24. */
export const ICON_GRID = 100 / 24;

/**
 * The markup to hand to `addIcon`, rescaled onto Obsidian's 100-unit box.
 *
 * `transform` rather than rewritten coordinates: the scale is applied to the
 * whole group, so it moves the strokes with the paths and the drawn weight stays
 * Lucide's (a `stroke-width="2"` on a 24 grid is 2/24 of the box, and the same 2
 * on the scaled 100-unit box is 8.33/100 of it -- the same line).
 */
export function registerableSvg(icon: FallbackIcon): string {
  return `<g transform="scale(${ICON_GRID})">${icon.svg}</g>`;
}

// The `addIcon` signature is injected rather than imported, so this module stays
// importable by tests (there is no `obsidian` module outside the app).
export type AddIcon = (name: string, svg: string) => void;

/**
 * Register every fallback. Called once on plugin load.
 *
 * Cheap and idempotent: `addIcon` overwrites, so calling it from all three
 * plugins at once is harmless, and it means no plugin has to know whether
 * another one already registered them.
 */
export function registerFallbackIcons(addIcon: AddIcon): void {
  for (const icon of FALLBACK_ICONS) {
    addIcon(icon.name, registerableSvg(icon));
  }
}

/**
 * The name to hand to `setIcon` for a wanted icon.
 *
 * Exact registered names are resolved **first, across the whole table**, before
 * any alias is considered. Doing both in one pass looks equivalent and is not:
 * `pin` appears as a fallback alias of the `pin-off` entry, so a single pass
 * would resolve `iconName("pin")` to `sfc-pin-off` and quietly draw a crossed-out
 * pin wherever an un-crossed one was intended. The two names mean opposite
 * things, so the mistake would be legible rather than obvious.
 *
 * Pure, so the mapping is testable: `setIcon` itself needs a live app.
 */
export function iconName(wanted: string): string {
  for (const icon of FALLBACK_ICONS) {
    if (icon.name === wanted) return icon.name;
  }
  for (const icon of FALLBACK_ICONS) {
    if (icon.preferred.includes(wanted)) return icon.name;
  }
  // Not one of ours: hand it through unchanged, because the caller may well be
  // naming a built-in that does exist.
  return wanted;
}