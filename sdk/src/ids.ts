/**
 * Stable identifiers.
 *
 * The whole design rests on one property: a card's id must depend on **where
 * the card lives and what it says**, and on nothing else. If the id were a
 * counter, editing unrelated text above a card would recreate it and throw away
 * its scheduling history -- which is exactly the failure users notice and
 * cannot explain.
 *
 * So: prefer the explicit ``^block-id`` when the note has one, because it is
 * stable across any edit anywhere in the file. Fall back to a hash of the
 * normalised text plus its ordinal, which survives unrelated edits but
 * deliberately treats an edited card as a new card.
 */

/** FNV-1a, 32 bit, as 8 lowercase hex digits. Small, fast, dependency free. */
export function hash32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Collapse whitespace and trim, so reformatting a card is not an edit. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function cardId(path: string, text: string, blockId?: string | null): string {
  if (blockId) return `b:${path}#${blockId}`;
  return `h:${hash32(path)}-${hash32(normalizeText(text))}`;
}

let counter = 0;

/** A unique-enough id for entities that have no natural key (todos, logs). */
export function randomId(prefix = ""): string {
  counter = (counter + 1) % 0x10000;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0x1000000).toString(36);
  const seq = counter.toString(36);
  return `${prefix}${time}${seq}${rand}`;
}
