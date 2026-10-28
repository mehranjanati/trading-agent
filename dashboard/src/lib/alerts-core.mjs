// alerts-core.mjs — pure helpers for the Telegram alert prefs UI (docs/09 §9.3a).
// Stdlib-only and framework-free, same rule as groups-core/setups-core: the
// page renders what these say, so the topic list and the dirty check are
// testable without a browser.

/** The seven alert topics, with Persian labels (numbers/identifiers stay Latin).
 *  SAFETY is deliberately first — it is the one topic the user should never mute. */
export const TOPIC_LABELS = [
  { topic: "SAFETY", fa: "ایمنی (کیل‌سوییچ، خطا)" },
  { topic: "TRIGGERED", fa: "تریگر شد" },
  { topic: "INVALIDATED", fa: "ابطال شد" },
  { topic: "ANALYSIS_READY", fa: "تحلیل آماده شد" },
  { topic: "APPROVAL_REQUESTED", fa: "تأیید لازم است" },
  { topic: "ORDER_UPDATE", fa: "وضعیت سفارش" },
  { topic: "POSITION_DIGEST", fa: "خلاصه پوزیشن‌ها" },
];

/** One alert-pref row as the API returns it; PrefMap is the topic→enabled map the UI holds. */
/** @typedef {{ topic?: string, enabled?: boolean }} PrefRow */
/** @typedef {Record<string, boolean>} PrefMap */

/** Normalize the API shape ({prefs:[{topic,enabled}]}) into a map, defaulting
 *  absent topics to enabled (the server rule, mirrored so the UI never shows a
 *  topic as off when the backend would still push it).
 *  @param {PrefRow[]|null|undefined} prefs
 *  @returns {PrefMap} */
export function prefsToMap(prefs) {
  /** @type {PrefMap} */
  const map = {};
  for (const p of prefs ?? []) if (typeof p?.topic === "string" && p.topic) map[p.topic] = p.enabled !== false;
  return map;
}

/** Which topics changed vs the loaded map — only these are POSTed (PATCH-style:
 *  the server upserts exactly what it receives).
 *  @param {PrefMap} loaded
 *  @param {PrefMap} current
 *  @returns {PrefMap} */
export function diffPrefs(loaded, current) {
  /** @type {PrefMap} */
  const out = {};
  for (const { topic } of TOPIC_LABELS) {
    const was = loaded[topic] ?? true;
    const now = current[topic] ?? true;
    if (was !== now) out[topic] = now;
  }
  return out;
}
