import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const submitInvoiceEvent = vi.fn();
vi.mock("../../src/services/superPdpService.js", () => ({
  default: { submitInvoiceEvent: (...a) => submitInvoiceEvent(...a) },
}));

import { reportPurchaseInvoicePaymentIfNeeded } from "../../src/utils/purchaseInvoiceEInvoiceHelper.js";

const WS = "ws-1";

const buildInvoice = (over = {}) => ({
  _id: "pi-1",
  invoiceNumber: "FA-001",
  source: "SUPERPDP",
  superPdpInvoiceId: "sp-9",
  eInvoiceStatus: "RECEIVED",
  ...over,
});

beforeEach(() => {
  submitInvoiceEvent.mockReset();
});

describe("reportPurchaseInvoicePaymentIfNeeded", () => {
  it("émet l'événement et passe eInvoiceStatus à PAID si succès", async () => {
    submitInvoiceEvent.mockResolvedValue({ success: true });
    const invoice = buildInvoice();

    const ok = await reportPurchaseInvoicePaymentIfNeeded(invoice, WS);

    expect(ok).toBe(true);
    expect(submitInvoiceEvent).toHaveBeenCalledWith(WS, "sp-9", "fr:211");
    expect(invoice.eInvoiceStatus).toBe("PAID");
    expect(invoice.eInvoicePaymentReportStatus).toBe("REPORTED");
  });

  it("ne fait rien pour une facture non-SuperPDP (saisie manuelle)", async () => {
    const invoice = buildInvoice({ source: "MANUAL" });

    const ok = await reportPurchaseInvoicePaymentIfNeeded(invoice, WS);

    expect(ok).toBe(false);
    expect(submitInvoiceEvent).not.toHaveBeenCalled();
    expect(invoice.eInvoiceStatus).toBe("RECEIVED");
  });

  it("ne fait rien si le statut e-invoice n'est pas payable (déjà PAID)", async () => {
    const invoice = buildInvoice({ eInvoiceStatus: "PAID" });

    const ok = await reportPurchaseInvoicePaymentIfNeeded(invoice, WS);

    expect(ok).toBe(false);
    expect(submitInvoiceEvent).not.toHaveBeenCalled();
  });

  it("ne lève pas et ne change pas le statut si l'émission échoue", async () => {
    submitInvoiceEvent.mockResolvedValue({ success: false, error: "boom" });
    const invoice = buildInvoice();

    const ok = await reportPurchaseInvoicePaymentIfNeeded(invoice, WS);

    expect(ok).toBe(false);
    expect(invoice.eInvoiceStatus).toBe("RECEIVED");
    expect(invoice.eInvoicePaymentReportStatus).toBe("ERROR");
  });
});
