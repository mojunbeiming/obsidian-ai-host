import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes, formatDuration, formatInterval, formatMinutes } from "../.build/interval.js";

test("formatInterval picks a unit per magnitude", () => {
  assert.equal(formatInterval(0), "0 min");
  assert.equal(formatInterval(-5), "0 min");
  assert.equal(formatInterval(1 / 1440), "1 min");
  assert.equal(formatInterval(10 / 1440), "10 min");
  assert.equal(formatInterval(30 / 1440), "30 min");
});

test("formatInterval shows hours between a minute and a day", () => {
  assert.equal(formatInterval(3 / 24), "3 h");
  assert.equal(formatInterval(1.5 / 24), "1.5 h");
});

test("formatInterval keeps one decimal only below ten days", () => {
  assert.equal(formatInterval(4.7), "4.7 d");
  assert.equal(formatInterval(3), "3 d");
  // At ten days and above the decimal is noise.
  assert.equal(formatInterval(10.4), "10 d");
  assert.equal(formatInterval(29.6), "30 d");
});

test("formatInterval switches to months and years", () => {
  assert.equal(formatInterval(30), "1.0 mo");
  assert.equal(formatInterval(75), "2.5 mo");
  assert.equal(formatInterval(364), "12.0 mo");
  assert.equal(formatInterval(365.25), "1.0 yr");
  assert.equal(formatInterval(450), "1.2 yr");
});

test("formatInterval never returns a bare zero-day interval", () => {
  // A learning step of a fraction of a minute still has to read as "1 min",
  // otherwise the button appears to promise "0 m" and gets distrusted.
  assert.equal(formatInterval(0.0001), "1 min");
});

test("formatInterval tolerates non-finite input", () => {
  assert.equal(formatInterval(NaN), "0 min");
  assert.equal(formatInterval(Infinity), "0 min");
});

test("formatMinutes is the minutes entry point", () => {
  assert.equal(formatMinutes(1), "1 min");
  assert.equal(formatMinutes(10), "10 min");
  assert.equal(formatMinutes(1440), "1 d");
});

test("formatDuration reads as elapsed time", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-1), "0s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(120_000), "2m");
});

test("formatBytes picks a unit, one decimal below ten of it", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(-1), "0 B");
  assert.equal(formatBytes(840), "840 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  // 12.0 KB carries a decimal that says nothing, so it is dropped.
  assert.equal(formatBytes(12_300), "12 KB");
  assert.equal(formatBytes(4_200_000), "4.0 MB");
  assert.equal(formatBytes(125_000_000), "119 MB");
  assert.equal(formatBytes(NaN), "0 B");
});