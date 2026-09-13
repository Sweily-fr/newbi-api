import { describe, it, expect } from "vitest";
import {
  toExpenseCategory,
  toPurchaseInvoiceCategory,
  toForecastCategory,
  resolveForecastCategoryInput,
  resolvePurchaseInvoiceCategoryInput,
  isSubcategory,
  SUBCATEGORY_TO_EXPENSE_CATEGORY,
  PI_TO_EXPENSE_CATEGORY,
} from "../../src/utils/categoryTaxonomy.js";

describe("categoryTaxonomy", () => {
  it("rabat une sous-catégorie fine sur la catégorie large des transactions", () => {
    expect(toExpenseCategory("parking")).toBe("TRAVEL");
    expect(toExpenseCategory("comptabilite")).toBe("SERVICES");
    expect(toExpenseCategory("telephone")).toBe("UTILITIES");
    expect(toExpenseCategory("TRAVEL")).toBe("TRAVEL");
    expect(toExpenseCategory("TRANSPORT")).toBe("TRAVEL");
    expect(toExpenseCategory("ENERGY")).toBe("UTILITIES");
    expect(toExpenseCategory("OTHER_EXPENSE")).toBe("OTHER");
    expect(toExpenseCategory("inconnu")).toBe("OTHER");
    expect(toExpenseCategory(null)).toBe("OTHER");
  });

  it("rabat sur l'enum facture d'achat", () => {
    expect(toPurchaseInvoiceCategory("parking")).toBe("TRANSPORT");
    expect(toPurchaseInvoiceCategory("hotel")).toBe("TRANSPORT");
    expect(toPurchaseInvoiceCategory("salaire")).toBe("SERVICES");
    expect(toPurchaseInvoiceCategory("TELECOMMUNICATIONS")).toBe(
      "TELECOMMUNICATIONS",
    );
    expect(toPurchaseInvoiceCategory("autre")).toBe("OTHER");
    expect(toPurchaseInvoiceCategory(undefined)).toBe("OTHER");
  });

  it("rabat sur l'enum prévision selon le sens", () => {
    expect(toForecastCategory("parking", "EXPENSE")).toBe("TRANSPORT");
    expect(toForecastCategory("hotel", "EXPENSE")).toBe("OTHER_EXPENSE");
    expect(toForecastCategory("OTHER", "EXPENSE")).toBe("OTHER_EXPENSE");
    expect(toForecastCategory("TRAVEL", "EXPENSE")).toBe("TRANSPORT");
    expect(toForecastCategory("ENERGY", "EXPENSE")).toBe("ENERGY");
    expect(toForecastCategory("honoraires", "INCOME")).toBe("SALES");
    expect(toForecastCategory("remboursements_revenus", "INCOME")).toBe(
      "REFUNDS_RECEIVED",
    );
    expect(toForecastCategory("dividendes", "INCOME")).toBe("OTHER_INCOME");
    expect(toForecastCategory("SALES", "INCOME")).toBe("SALES");
    expect(toForecastCategory(null, "INCOME")).toBeNull();
  });

  it("résout la saisie en couple catégorie large / sous-catégorie", () => {
    expect(
      resolveForecastCategoryInput({ subcategory: "parking", type: "EXPENSE" }),
    ).toEqual({ category: "TRANSPORT", subcategory: "parking" });
    expect(
      resolveForecastCategoryInput({ category: "RENT", type: "EXPENSE" }),
    ).toEqual({ category: "RENT", subcategory: null });
    // Un code large passé dans subcategory (valeur héritée) reste un code large
    expect(
      resolveForecastCategoryInput({ subcategory: "SALES", type: "INCOME" }),
    ).toEqual({ category: "SALES", subcategory: null });
    expect(resolveForecastCategoryInput({ type: "INCOME" })).toEqual({
      category: null,
      subcategory: null,
    });
    expect(
      resolvePurchaseInvoiceCategoryInput({ subcategory: "comptabilite" }),
    ).toEqual({ category: "SERVICES", subcategory: "comptabilite" });
    expect(resolvePurchaseInvoiceCategoryInput({})).toEqual({
      category: "OTHER",
      subcategory: null,
    });
  });

  it("ne connaît que des sous-catégories du référentiel", () => {
    expect(isSubcategory("parking")).toBe(true);
    expect(isSubcategory("TRAVEL")).toBe(false);
    expect(isSubcategory("__proto__")).toBe(false);
    expect(Object.keys(SUBCATEGORY_TO_EXPENSE_CATEGORY)).toHaveLength(68);
    expect(PI_TO_EXPENSE_CATEGORY.TRANSPORT).toBe("TRAVEL");
    expect(PI_TO_EXPENSE_CATEGORY.RENT).toBe("RENT");
  });
});
