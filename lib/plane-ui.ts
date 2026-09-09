// Presentation rules shared by the board cards and the work-item preview, so
// a label, a priority, or a date reads the same in both places.
import type { CSSProperties } from "react";

/** Plane's five priorities, highest first; anything else sorts last. */
export const PRIORITY_ORDER = ["urgent", "high", "medium", "low", "none"];

export function priorityRank(priority: string): number {
  const index = PRIORITY_ORDER.indexOf(priority);
  return index === -1 ? PRIORITY_ORDER.length : index;
}

/** Urgent is the only priority Plane shows in a warning color. */
export const PRIORITY_CLASS: Record<string, string> = {
  urgent: "border-destructive/40 bg-destructive/10 text-destructive",
  high: "border-foreground/30 text-foreground",
  medium: "border-border text-muted-foreground",
  low: "border-border text-muted-foreground",
  none: "border-border text-muted-foreground",
};

export function priorityClass(priority: string): string {
  return PRIORITY_CLASS[priority] ?? PRIORITY_CLASS.none;
}

/**
 * Tint a label pill with the label's own color, the way Plane does. Plane
 * stores colors as `#rrggbb`; anything else falls back to the theme border.
 */
export function labelStyle(color: string | null): CSSProperties | undefined {
  if (color === null || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  return { borderColor: `${color}66`, backgroundColor: `${color}1a` };
}

export function dotStyle(color: string | null): CSSProperties | undefined {
  if (color === null || color === "" || !/^#[0-9a-f]{3,8}$/i.test(color)) return undefined;
  return { backgroundColor: color };
}

/** A date-only value like a target date: "12 Mar". */
export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A timestamp, for the preview's created/updated line and comments. */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** An attachment's size, in the units Plane's own UI uses. */
export function formatBytes(size: number | null): string {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}
