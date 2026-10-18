// registry.ts — the pinned-WASM catalog, read from the Go plane.
//
// WHY THE GO PLANE: registry_endpoint.go serves GET /strategies/registry from
// the SAME registry the runner executes (id@version + sha256 + configuration),
// so the dashboard can never advertise a pin the watcher would refuse. The
// library tab used to hardcode this list; this endpoint is what replaces it.
//
// The base is ANALYZE_BASE — the Go plane, the same host /analyze uses. When
// that host is unset the value defaults to the Worker (which has no such
// route), so the call fails and the caller renders the labelled offline
// fallback instead of an empty tab.
//
// Fail-soft, exactly like symbols.ts: never throws, always a Result.
import { ANALYZE_BASE, type Result } from "./api";

export interface RegistryEntry {
  id: string;
  version: string;
  file: string;
  name?: string;
  description?: string;
  sha256: string;
  configuration: Record<string, unknown>;
  /** ADR-011 lifecycle: "retired" stays executable but is not selectable for
   *  new work. The Go registry always serves the field; older deployments may
   *  omit it (treated as active). */
  status?: "active" | "retired";
  retired_reason?: string;
}

export interface RegistryData {
  strategies: RegistryEntry[];
  count: number;
  /** Selectable subset (active only) — what a NEW pin set may draw from. */
  active_count?: number;
  at: string;
}

/** getStrategyRegistry lists the pinned artifacts the runner can execute. */
export async function getStrategyRegistry(): Promise<Result<RegistryData>> {
  try {
    const res = await fetch(`${ANALYZE_BASE}/strategies/registry`, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    const at: string = body?.at ?? new Date().toISOString();
    const strategies: RegistryEntry[] = Array.isArray(body?.strategies)
      ? body.strategies
          .filter((e: unknown) => !!e && typeof (e as RegistryEntry).id === "string" && typeof (e as RegistryEntry).version === "string")
          .map((e: RegistryEntry) => ({
            id: e.id,
            version: e.version,
            file: typeof e.file === "string" ? e.file : "",
            name: typeof e.name === "string" ? e.name : undefined,
            description: typeof e.description === "string" ? e.description : undefined,
            sha256: typeof e.sha256 === "string" ? e.sha256 : "",
            configuration: e.configuration && typeof e.configuration === "object" ? e.configuration : {},
          }))
      : [];
    return { ok: true, data: { strategies, count: strategies.length, at }, at, ageMs: Date.now() - Date.parse(at) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
