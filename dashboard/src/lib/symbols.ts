// symbols.ts — Toobit-backed tradeable symbol list (via GET /api/symbols).
//
// Source of truth is the VENUE (Toobit contracts), not the risk allowlist:
// the list shows every tradeable *-SWAP-USDT market, each badged against the
// ACTIVE strategy_configs allowlist ("tradeable now" vs "venue-only").
//
// Fail-soft: a stale cache answers with stale:true; a total failure answers
// with symbols:[] and the page renders UNAVAILABLE, never a crash.
import { API_BASE, type Result } from "./api";

export interface SymbolsData {
  symbols: string[];
  allowlist: string[];
  stale: boolean;
  at: string;
}

const SYM_RE = /^[A-Z]{2,12}USDT$/;

export function isTradeable(symbols: SymbolsData | null, symbol: string): boolean {
  if (!symbols || !SYM_RE.test(symbol)) return false;
  return symbols.allowlist.includes(symbol);
}

export function validateSymbolInput(raw: string): string | null {
  const s = String(raw ?? "").toUpperCase().trim();
  return SYM_RE.test(s) ? s : null;
}

export async function getSymbols(): Promise<Result<SymbolsData>> {
  try {
    const res = await fetch(`${API_BASE}/api/symbols`, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    const at: string = body?.at ?? new Date().toISOString();
    const symbols = Array.isArray(body?.symbols) ? body.symbols.filter((s: unknown) => typeof s === "string") : [];
    const allowlist = Array.isArray(body?.allowlist) ? body.allowlist.filter((s: unknown) => typeof s === "string") : [];
    return { ok: true, data: { symbols, allowlist, stale: body?.stale === true, at }, at, ageMs: Date.now() - Date.parse(at) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
