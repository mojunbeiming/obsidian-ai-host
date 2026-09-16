/**
 * Human interval labels: ``10 min`` / ``3 h`` / ``4 d`` / ``2.5 mo`` / ``1.2 yr``.
 *
 * The label is the only feedback a learner gets before choosing a rating, so
 * the rounding is deliberately opinionated:
 *
 * * under 10 days keep one decimal (``4.7 d``) because the difference between
 *   4 and 5 days is meaningful at that scale;
 * * at 10 days and above round to whole days, because the decimal is noise;
 * * switch to months at 30 days and years at 365, never showing ``400 d``.
 */

import { MINUTES_PER_DAY } from "./clock";

export function formatInterval(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return "0 min";
  if (days < 1 / 24) {
    return `${Math.max(1, Math.round(days * MINUTES_PER_DAY))} min`;
  }
  if (days < 1) {
    const hours = days * 24;
    if (Math.abs(hours - Math.round(hours)) < 0.1) return `${Math.round(hours)} h`;
    return `${hours.toFixed(1)} h`;
  }
  if (days < 30) {
    if (days < 10 && Math.abs(days - Math.round(days)) > 0.05) {
      return `${days.toFixed(1)} d`;
    }
    return `${Math.round(days)} d`;
  }
  if (days < 365) return `${(days / 30.4375).toFixed(1)} mo`;
  return `${(days / 365.25).toFixed(1)} yr`;
}

export function formatMinutes(minutes: number): string {
  return formatInterval(minutes / MINUTES_PER_DAY);
}

/** ``12s`` / ``1m 30s`` -- used for the "thought for" readout. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * ``840 B`` / ``12.3 KB`` / ``4.1 MB`` -- sizes, for "you are about to delete
 * this much".
 *
 * Binary units with the conventional labels, and KB/MB rather than KiB/MiB
 * because the number is read by someone deciding whether to delete holiday
 * photos, not by a filesystem. One decimal from KB up: a five-gigabyte pile
 * shown as ``5 GB`` hides whether it was 5.0 or 5.9, which is the difference
 * between "fine" and "wait".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}