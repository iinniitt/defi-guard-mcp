/**
 * Freemium metering scaffold (OFF by default).
 *
 * Design (see PRODUCTIZATION.md):
 *  - Free tier  : data tools + token_safety_screen unlimited (the funnel);
 *                 premium tools (scan_dangerous_capabilities, approval_risk) get a
 *                 generous soft daily limit.
 *  - Pro tier   : everything unlimited. Activated via DEFI_GUARD_TIER=pro or the
 *                 presence of DEFI_GUARD_LICENSE_KEY (key validation lands with billing).
 *
 * Enforcement is gated behind DEFI_GUARD_METERING=on so shipping this module does NOT
 * degrade the free experience before there is a way to buy Pro. Until billing exists,
 * everyone stays effectively unlimited unless they opt in.
 *
 * Usage state is a per-day JSON counter at ~/.defi-guard/usage.json — local only,
 * never transmitted (stdio MCPs run on the user's machine; this is a soft limit,
 * not DRM, and the file says so).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Tier = "free" | "pro";

/** Tools gated in the free tier once metering is on. */
export const PREMIUM_TOOLS = ["scan_dangerous_capabilities", "approval_risk"] as const;

/** Combined daily allowance for premium tools in the free tier. */
export const FREE_DAILY_LIMIT = 25;

const STATE_DIR = join(homedir(), ".defi-guard");
const STATE_FILE = join(STATE_DIR, "usage.json");

interface UsageState {
  _note: string;
  date: string; // YYYY-MM-DD (UTC)
  counts: Record<string, number>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function meteringEnabled(): boolean {
  return (process.env.DEFI_GUARD_METERING ?? "").toLowerCase() === "on";
}

export function getTier(): Tier {
  const t = (process.env.DEFI_GUARD_TIER ?? "").toLowerCase();
  if (t === "pro") return "pro";
  // A license key implies pro; real validation ships with the billing rail.
  if (process.env.DEFI_GUARD_LICENSE_KEY) return "pro";
  return "free";
}

function loadState(): UsageState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as UsageState;
    if (s.date === today() && s.counts && typeof s.counts === "object") return s;
  } catch {
    // missing or corrupt -> fresh state
  }
  return {
    _note: "Local soft-limit counter for defi-guard-mcp free tier. Never transmitted.",
    date: today(),
    counts: {},
  };
}

function saveState(s: UsageState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {
    // Metering must never break the tool: if we cannot persist, fail open.
  }
}

export interface Allowance {
  allowed: boolean;
  remainingToday: number | null; // null = unlimited
  message?: string;
}

/**
 * Check-and-record one use of `tool`. Fails OPEN in every ambiguous case:
 * metering off, pro tier, non-premium tool, or unwritable state file.
 */
export function meterUse(tool: string): Allowance {
  if (!meteringEnabled() || getTier() === "pro") return { allowed: true, remainingToday: null };
  if (!(PREMIUM_TOOLS as readonly string[]).includes(tool)) return { allowed: true, remainingToday: null };

  const s = loadState();
  const used = (PREMIUM_TOOLS as readonly string[]).reduce((n, t) => n + (s.counts[t] ?? 0), 0);
  if (used >= FREE_DAILY_LIMIT) {
    return {
      allowed: false,
      remainingToday: 0,
      message:
        `Free-tier daily limit reached (${FREE_DAILY_LIMIT} premium checks/day across ${PREMIUM_TOOLS.join(", ")}). ` +
        `Resets at 00:00 UTC. Data tools and token_safety_screen remain unlimited. ` +
        `Set DEFI_GUARD_TIER=pro once you have a license (see the README for availability).`,
    };
  }
  s.counts[tool] = (s.counts[tool] ?? 0) + 1;
  saveState(s);
  return { allowed: true, remainingToday: FREE_DAILY_LIMIT - used - 1 };
}
