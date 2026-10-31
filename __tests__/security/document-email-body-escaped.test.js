import { describe, it, expect } from "vitest";
import { generateReminderEmailHtml } from "../../src/services/documentEmailService.js";

// Le message des e-mails de documents est saisi en texte brut : il est
// affiché tel quel, sauts de ligne conservés, sans HTML interprété.
describe("Message des e-mails de documents", () => {
  const variables = {
    invoiceNumber: "F-2026-0001",
    clientName: "Client Test",
    totalAmount: "120,00 €",
    dueDate: "15/11/2026",
    companyName: "Entreprise Test",
  };

  it("le texte saisi est affiché comme du texte", () => {
    const html = generateReminderEmailHtml(
      'Bonjour,\n<a href="https://exemple.test">Payer</a><img src=x onerror=alert(1)>',
      variables,
      "FIRST",
    );
    expect(html).not.toContain('<a href="https://exemple.test">');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("les sauts de ligne deviennent des retours à la ligne", () => {
    const html = generateReminderEmailHtml("Ligne 1\nLigne 2", variables, "FIRST");
    expect(html).toContain("Ligne 1<br>Ligne 2");
  });
});
