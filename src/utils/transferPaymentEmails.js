/**
 * E-mail au vendeur quand le destinataire d'un transfert payant a payé.
 * Mise en page commune des e-mails Newbi (renderEmail : pas d'icône, aucun
 * mot ni signe de ponctuation seul en bout de ligne).
 */
import { escapeHtml, renderEmail } from "./trialEmails.js";

const paragraph = (html, margin = "0 0 16px 0") =>
  `<p style="font-size: 15px; color: #4b5563; margin: ${margin}; line-height: 1.6;">${html}</p>`;

const PROVIDER_LABELS = {
  stripe: "Carte bancaire (Stripe)",
  paypal: "PayPal",
};

function detailRows(rows) {
  const cells = rows
    .map(
      ([label, value]) => `
          <tr>
            <td style="padding: 10px 0; font-size: 14px; color: #6b7280; border-bottom: 1px solid #f3f4f6;">${escapeHtml(label)}</td>
            <td style="padding: 10px 0; font-size: 14px; color: #1a1a1a; font-weight: 500; text-align: right; border-bottom: 1px solid #f3f4f6;">${escapeHtml(value)}</td>
          </tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; margin: 0 0 24px 0;">${cells}
        </table>`;
}

export function buildTransferPaidEmail({
  amount,
  transferTitle,
  payerEmail,
  provider,
  fileCount = 0,
  url,
}) {
  const what = transferTitle
    ? `le transfert « ${transferTitle} »`
    : "votre transfert de fichiers";
  const files = `${fileCount} fichier${fileCount > 1 ? "s" : ""}`;
  const rows = [
    ["Montant", amount],
    payerEmail ? ["Payé par", payerEmail] : null,
    PROVIDER_LABELS[provider]
      ? ["Moyen de paiement", PROVIDER_LABELS[provider]]
      : null,
    ["Fichiers", files],
  ].filter(Boolean);

  return {
    subject: `Paiement reçu : ${amount}`,
    text: [
      `Votre client a payé ${amount} pour ${what}.`,
      "Les fichiers sont maintenant disponibles au téléchargement.",
      payerEmail ? `Payé par : ${payerEmail}` : null,
      "L'argent a été versé directement sur votre compte, sans commission Newbi.",
      `Voir mes transferts : ${url}`,
    ]
      .filter(Boolean)
      .join("\n"),
    html: renderEmail({
      preheader: `Votre client a payé ${amount}.`,
      badge: "PAIEMENT REÇU",
      title: "Votre transfert a été payé",
      bodyHtml: `
        ${paragraph(`Votre client a payé <strong style="color: #1a1a1a;">${escapeHtml(amount)}</strong> pour ${escapeHtml(what)}. Les fichiers sont maintenant disponibles au téléchargement.`, "0 0 24px 0")}
        ${detailRows(rows)}
        ${paragraph("L'argent a été versé directement sur votre compte, sans commission Newbi.", "0 0 24px 0")}
      `,
      ctaLabel: "Voir mes transferts",
      ctaUrl: url,
    }),
  };
}
