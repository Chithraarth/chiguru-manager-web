// Currency support for the manager device. The farm owner picks their country
// in the main farm app, which stores an ISO currency code on the farm profile.
// We fetch it once per session (when online), cache it locally so offline
// sessions keep the right currency, and format all money with it.

import { apiFetch } from "./api";

const CURRENCY_KEY = "manager_currency";

function activeCurrency(): string {
  try {
    return window.localStorage.getItem(CURRENCY_KEY) || "INR";
  } catch {
    return "INR";
  }
}

/** Fetch the farm's currency from the server and cache it. Best-effort. */
export async function refreshCurrency(): Promise<void> {
  try {
    const profile = await apiFetch<{ currency?: string }>("/farm/profile");
    if (profile?.currency) {
      window.localStorage.setItem(CURRENCY_KEY, profile.currency);
    }
  } catch {
    /* offline or not paired yet — keep the cached value */
  }
}

function formatter(maxFraction: number): Intl.NumberFormat {
  const currency = activeCurrency();
  const locale = currency === "INR" ? "en-IN" : undefined;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFraction,
  });
}

/** Format a money amount in the farm's currency, e.g. 450 → "₹450" / "$450". */
export function fmtMoney(n: number | string | null | undefined, maxFraction = 2): string {
  const v = Number(n ?? 0);
  try {
    return formatter(maxFraction).format(Number.isFinite(v) ? v : 0);
  } catch {
    return `₹${v.toLocaleString("en-IN")}`;
  }
}

/** Just the currency symbol, e.g. "₹", "$". */
export function curSymbol(): string {
  try {
    const parts = formatter(0).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? "₹";
  } catch {
    return "₹";
  }
}
