/**
 * Feature flags — toggle in-development features without changing runtime defaults.
 *
 * Read at call time (not at module load) so tests and runtime overrides take effect.
 *
 * Convention: variable absent OR set to anything other than "true" → flag OFF.
 */

export function isAppTrialEnabled() {
  return process.env.ENABLE_APP_TRIAL === "true";
}
