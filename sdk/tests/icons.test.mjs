import assert from "node:assert/strict";
import { test } from "node:test";

import { FALLBACK_ICONS, ICON_GRID, iconName, registerableSvg, registerFallbackIcons } from "../.build/icons.js";

test("a wanted icon maps to our own registered name", () => {
  // The point of the mapping: `setIcon` renders nothing for a name Obsidian
  // does not have, and an icon-only button with nothing in it is invisible.
  assert.equal(iconName("pin-off"), "sfc-pin-off");
  assert.equal(iconName("pin"), "sfc-pin");
  assert.equal(iconName("alert-triangle"), "sfc-alert-triangle");
  assert.equal(iconName("triangle-alert"), "sfc-alert-triangle");
  assert.equal(iconName("wifi-off"), "sfc-wifi-off");
  assert.equal(iconName("calendar"), "sfc-calendar");
});

test("the flashcards entry point has a name that cannot render blank", () => {
  // The ribbon button is the plugin's only always-visible entry point. If its
  // icon name stops resolving, the button stays and draws nothing -- and an
  // invisible entry point reads as "this plugin has none".
  assert.equal(iconName("gallery-vertical-end"), "sfc-cards");
  assert.equal(iconName("layers"), "sfc-cards", "the old name is still claimed");
  assert.equal(iconName("sfc-cards"), "sfc-cards");
  const cards = FALLBACK_ICONS.find((icon) => icon.name === "sfc-cards");
  assert.ok(cards, "sfc-cards is not registered");
  assert.ok(cards.preferred.length > 0);
  assert.ok(cards.svg.length > 40);
});

test("an exact registered name wins over another entry's alias", () => {
  // `pin` is an alias of the `pin-off` entry, so a single-pass lookup would
  // resolve `iconName("pin")` to a crossed-out pin. Opposite meanings, and the
  // mistake would be legible rather than obvious.
  assert.equal(iconName("pin"), "sfc-pin");
  assert.notEqual(iconName("pin"), "sfc-pin-off");
});

test("an unknown name is passed through unchanged", () => {
  // The caller may be naming a built-in that does exist; rewriting it would
  // break icons we do not know about.
  assert.equal(iconName("refresh-cw"), "refresh-cw");
  assert.equal(iconName(""), "");
});

test("every preferred alias resolves to its own family", () => {
  for (const icon of FALLBACK_ICONS) {
    for (const alias of icon.preferred) {
      assert.equal(iconName(alias), icon.name, `${alias} should map to ${icon.name}`);
    }
  }
});

test("our names are namespaced so they cannot shadow a built-in", () => {
  for (const icon of FALLBACK_ICONS) {
    assert.ok(icon.name.startsWith("sfc-"), `${icon.name} is not namespaced`);
  }
});

test("every fallback carries a drawable svg with the theme stroke", () => {
  for (const icon of FALLBACK_ICONS) {
    // `currentColor` is what makes an icon follow the theme instead of drawing
    // black on a dark ribbon. A filled shape uses it in `fill`, an outline in
    // `stroke`, so the check accepts either -- but it must be there.
    assert.ok(
      icon.svg.includes('currentColor'),
      `${icon.name} does not use currentColor`,
    );
    assert.ok(icon.svg.startsWith("<g"), `${icon.name} does not look like an svg fragment`);
    assert.ok(icon.svg.length > 40, `${icon.name} svg looks empty`);
  }
});

test("the ribbon icon is bold enough to read at ribbon size", () => {
  // Ink, not just an outline. The first `sfc-cards` was a thin outline of a card
  // behind a card: correct, and invisible in a column of a dozen icons, which is
  // exactly what "not noticeable" meant. A filled shape reads at 24px.
  const cards = FALLBACK_ICONS.find((icon) => icon.name === "sfc-cards");
  assert.ok(cards);
  assert.ok(
    cards.svg.includes('fill="currentColor"'),
    "the entry point has no filled shape",
  );
});

test("registerFallbackIcons registers every name exactly once each", () => {
  const seen = new Map();
  registerFallbackIcons((name, svg) => seen.set(name, svg));
  assert.equal(seen.size, FALLBACK_ICONS.length);
  for (const icon of FALLBACK_ICONS) {
    assert.equal(seen.get(icon.name), registerableSvg(icon));
  }
});

test("the registered markup is rescaled onto Obsidian's 100-unit box", () => {
  // `addIcon` wraps the markup in an `<svg viewBox="0 0 100 100">` (verified in
  // Obsidian's own bundle). A 24-grid fragment inside it draws in the top-left
  // corner at 24% scale -- the shipped symptom was "the ribbon icon is a dot".
  assert.equal(ICON_GRID, 100 / 24);
  for (const icon of FALLBACK_ICONS) {
    const payload = registerableSvg(icon);
    assert.ok(
      payload.startsWith(`<g transform="scale(${ICON_GRID})">`),
      `${icon.name} is not wrapped in the grid scale`,
    );
    assert.ok(payload.endsWith("</g>"), `${icon.name} wrapper is not closed`);
    assert.ok(payload.includes(icon.svg), `${icon.name} lost its drawing`);
    // The drawing spans a quarter of the box, so the wrapper is what fills it.
    assert.ok(24 * ICON_GRID >= 99.99 && 24 * ICON_GRID <= 100.01, "the scale does not reach 100 units");
  }
});

test("every drawing stays inside Lucide's 24-unit grid", () => {
  // The scale above assumes 24. A drawing pasted on some other grid (an Obsidian
  // 100-unit icon, a hand-made 32-unit one) would be scaled wrong in the other
  // direction -- too large and clipped -- so the assumption is checked here
  // rather than trusted.
  for (const icon of FALLBACK_ICONS) {
    // `-.36` is one coordinate, not the number 36: the token pattern has to take
    // the sign and the bare decimal point together, or a relative curve command
    // reads as an out-of-range coordinate.
    for (const number of icon.svg.match(/-?\d*\.?\d+/g) ?? []) {
      const value = Math.abs(Number(number));
      assert.ok(value <= 24, `${icon.name} has a coordinate outside the 24 grid: ${number}`);
    }
  }
});

test("registration is idempotent, so three plugins can all register", () => {
  // All three plugins call this on load and none of them knows whether another
  // already did. `addIcon` overwrites, so the result must be the same either way.
  const first = new Map();
  const second = new Map();
  registerFallbackIcons((name, svg) => first.set(name, svg));
  registerFallbackIcons((name, svg) => second.set(name, svg));
  assert.deepEqual([...first.entries()].sort(), [...second.entries()].sort());
});

test("no two icons claim the same registered name", () => {
  const names = FALLBACK_ICONS.map((icon) => icon.name);
  assert.equal(new Set(names).size, names.length);
});