/**
 * App-managed trial helpers.
 *
 * The app-managed trial is stored on the Organization document (Better Auth
 * collection "organization"). It runs for 14 days from signup, independent of
 * Stripe and the payment_method. The trial fields are:
 *   - trialStartDate: ISO string
 *   - trialEndDate:   ISO string
 *   - isTrialActive:  boolean — set to false by the cleanup cron once expired
 *   - hasUsedTrial:   boolean — anti-abuse, prevents re-trial after expiration
 *   - stripeTrialActive: boolean — discriminates a legacy Stripe trial from
 *                        the new app-managed trial
 *
 * isTrialAppActive() is the single source of truth and must match the version
 * in newbiv2/src/lib/trial-app.js exactly.
 */

export function isTrialAppActive(org) {
  if (!org) return false;
  if (org.isTrialActive !== true) return false;
  if (!org.trialEndDate) return false;
  const end = new Date(org.trialEndDate);
  if (Number.isNaN(end.getTime())) return false;
  return end.getTime() > Date.now();
}
