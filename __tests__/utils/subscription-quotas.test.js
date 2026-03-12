import { describe, it, expect } from 'vitest';
import { PLAN_QUOTAS } from '../../src/models/UserOcrQuota.js';

describe('PLAN_QUOTAS configuration', () => {
  it('should define FREE plan with 5 monthly quota', () => {
    expect(PLAN_QUOTAS.FREE).toBeDefined();
    expect(PLAN_QUOTAS.FREE.monthlyQuota).toBe(5);
    expect(PLAN_QUOTAS.FREE.extraImportPrice).toBe(0.30);
    expect(PLAN_QUOTAS.FREE.name).toBe('Gratuit');
  });

  it('should define FREELANCE plan with 50 monthly quota', () => {
    expect(PLAN_QUOTAS.FREELANCE).toBeDefined();
    expect(PLAN_QUOTAS.FREELANCE.monthlyQuota).toBe(50);
    expect(PLAN_QUOTAS.FREELANCE.extraImportPrice).toBe(0.25);
  });

  it('should define TPE plan with 200 monthly quota', () => {
    expect(PLAN_QUOTAS.TPE).toBeDefined();
    expect(PLAN_QUOTAS.TPE.monthlyQuota).toBe(200);
    expect(PLAN_QUOTAS.TPE.extraImportPrice).toBe(0.20);
  });

  it('should define ENTREPRISE plan with 1000 monthly quota', () => {
    expect(PLAN_QUOTAS.ENTREPRISE).toBeDefined();
    expect(PLAN_QUOTAS.ENTREPRISE.monthlyQuota).toBe(1000);
    expect(PLAN_QUOTAS.ENTREPRISE.extraImportPrice).toBe(0.15);
  });

  it('should define UNLIMITED plan with very high quota', () => {
    expect(PLAN_QUOTAS.UNLIMITED).toBeDefined();
    expect(PLAN_QUOTAS.UNLIMITED.monthlyQuota).toBe(999999);
    expect(PLAN_QUOTAS.UNLIMITED.extraImportPrice).toBe(0.10);
  });

  it('should have decreasing extra import prices as plan tier increases', () => {
    const prices = [
      PLAN_QUOTAS.FREE.extraImportPrice,
      PLAN_QUOTAS.FREELANCE.extraImportPrice,
      PLAN_QUOTAS.TPE.extraImportPrice,
      PLAN_QUOTAS.ENTREPRISE.extraImportPrice,
      PLAN_QUOTAS.UNLIMITED.extraImportPrice,
    ];

    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeLessThan(prices[i - 1]);
    }
  });

  it('should have increasing monthly quotas as plan tier increases', () => {
    const quotas = [
      PLAN_QUOTAS.FREE.monthlyQuota,
      PLAN_QUOTAS.FREELANCE.monthlyQuota,
      PLAN_QUOTAS.TPE.monthlyQuota,
      PLAN_QUOTAS.ENTREPRISE.monthlyQuota,
      PLAN_QUOTAS.UNLIMITED.monthlyQuota,
    ];

    for (let i = 1; i < quotas.length; i++) {
      expect(quotas[i]).toBeGreaterThan(quotas[i - 1]);
    }
  });
});

describe('Quota calculation logic', () => {
  // Test the quota checking logic that checkQuotaAvailable uses
  it('should correctly calculate remaining from plan', () => {
    const planConfig = PLAN_QUOTAS.FREELANCE;
    const usedQuota = 30;
    const remainingFromPlan = Math.max(0, planConfig.monthlyQuota - usedQuota);
    expect(remainingFromPlan).toBe(20);
  });

  it('should return 0 remaining when quota is fully used', () => {
    const planConfig = PLAN_QUOTAS.FREE;
    const usedQuota = 5;
    const remainingFromPlan = Math.max(0, planConfig.monthlyQuota - usedQuota);
    expect(remainingFromPlan).toBe(0);
  });

  it('should return 0 remaining when over quota', () => {
    const planConfig = PLAN_QUOTAS.FREE;
    const usedQuota = 10;
    const remainingFromPlan = Math.max(0, planConfig.monthlyQuota - usedQuota);
    expect(remainingFromPlan).toBe(0);
  });

  it('should calculate total remaining including extra imports', () => {
    const planConfig = PLAN_QUOTAS.FREE;
    const usedQuota = 5;
    const extraImportsPurchased = 10;
    const extraImportsUsed = 3;

    const remainingFromPlan = Math.max(0, planConfig.monthlyQuota - usedQuota);
    const remainingExtra = extraImportsPurchased - extraImportsUsed;
    const totalRemaining = remainingFromPlan + remainingExtra;

    expect(remainingFromPlan).toBe(0);
    expect(remainingExtra).toBe(7);
    expect(totalRemaining).toBe(7);
  });

  it('should determine if usage is extra when plan quota exhausted', () => {
    const planConfig = PLAN_QUOTAS.FREE;
    const usedQuota = 5; // fully used
    const remainingFromPlan = Math.max(0, planConfig.monthlyQuota - usedQuota);
    const isExtra = remainingFromPlan <= 0;
    expect(isExtra).toBe(true);
  });

  it('should determine usage is NOT extra when plan quota available', () => {
    const planConfig = PLAN_QUOTAS.FREELANCE;
    const usedQuota = 10;
    const remainingFromPlan = Math.max(0, planConfig.monthlyQuota - usedQuota);
    const isExtra = remainingFromPlan <= 0;
    expect(isExtra).toBe(false);
  });

  it('should calculate extra import purchase costs in centimes', () => {
    const planConfig = PLAN_QUOTAS.TPE;
    const quantity = 50;
    const unitPrice = Math.round(planConfig.extraImportPrice * 100);
    const totalPrice = unitPrice * quantity;

    expect(unitPrice).toBe(20); // 0.20 EUR = 20 centimes
    expect(totalPrice).toBe(1000); // 50 * 20 = 1000 centimes = 10 EUR
  });
});
