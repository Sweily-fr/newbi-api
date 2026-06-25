import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Génère un certificat de signature électronique LISIBLE (PDF) à partir de la
 * piste d'audit renvoyée par l'API eSignature (OpenAPI).
 *
 * La piste d'audit brute est un JSON (identité, authentification OTP, IP,
 * horodatages, empreintes SHA-256, journal d'événements) : c'est la preuve
 * légale, mais illisible pour un client. On la met en forme dans un document
 * présentable, archivé sur R2 à côté du document signé.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const BRAND = rgb(0.353, 0.314, 1); // #5a50ff
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.42, 0.45, 0.5);

const formatDate = (value) => {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });
};

/**
 * @param {object} auditTrail - Objet renvoyé par esignatureService.downloadAuditTrail
 * @param {object} meta - { documentNumber, companyName }
 * @returns {Promise<Buffer>} PDF du certificat
 */
export async function buildProofCertificatePdf(auditTrail, meta = {}) {
  const data = auditTrail?.data || auditTrail || {};
  const sig = data.SignatureData || {};
  const docInfo = sig.document || {};
  const input = docInfo.inputDocuments?.[0] || {};
  const signed = docInfo.signedDocument || {};
  const signers = Array.isArray(sig.signers) ? sig.signers : [];
  const auditLog = Array.isArray(data.AuditData) ? data.AuditData : [];

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Certificat de signature - ${meta.documentNumber || ""}`);
  pdf.setProducer("Newbi");

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  // Saut de page automatique quand on atteint le bas
  const ensureSpace = (needed) => {
    if (y - needed < MARGIN) {
      page = pdf.addPage([A4.width, A4.height]);
      y = A4.height - MARGIN;
    }
  };

  // Découpe un texte pour qu'il tienne dans la largeur disponible
  const wrap = (text, f, size, maxWidth) => {
    const words = String(text ?? "").split(/\s+/);
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  };

  const drawText = (
    text,
    { f = font, size = 10, color = INK, indent = 0 } = {},
  ) => {
    const maxWidth = A4.width - MARGIN * 2 - indent;
    for (const line of wrap(text, f, size, maxWidth)) {
      ensureSpace(size + 4);
      page.drawText(line, { x: MARGIN + indent, y, size, font: f, color });
      y -= size + 4;
    }
  };

  // Ligne "label : valeur" (label gras, valeur normale, retour à la ligne géré)
  const drawField = (label, value) => {
    const size = 10;
    const labelText = `${label} : `;
    const labelWidth = bold.widthOfTextAtSize(labelText, size);
    ensureSpace(size + 4);
    page.drawText(labelText, { x: MARGIN, y, size, font: bold, color: INK });
    const maxWidth = A4.width - MARGIN * 2 - labelWidth;
    const lines = wrap(value, font, size, maxWidth);
    page.drawText(lines[0], {
      x: MARGIN + labelWidth,
      y,
      size,
      font,
      color: INK,
    });
    y -= size + 4;
    for (let i = 1; i < lines.length; i += 1) {
      ensureSpace(size + 4);
      page.drawText(lines[i], {
        x: MARGIN + labelWidth,
        y,
        size,
        font,
        color: INK,
      });
      y -= size + 4;
    }
  };

  const sectionTitle = (text) => {
    y -= 10;
    ensureSpace(20);
    page.drawText(text.toUpperCase(), {
      x: MARGIN,
      y,
      size: 11,
      font: bold,
      color: BRAND,
    });
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: A4.width - MARGIN, y },
      thickness: 0.7,
      color: rgb(0.9, 0.9, 0.92),
    });
    y -= 12;
  };

  // En-tête
  page.drawText("Certificat de signature électronique", {
    x: MARGIN,
    y,
    size: 18,
    font: bold,
    color: INK,
  });
  y -= 22;
  drawText(
    "Preuve de signature conforme au règlement eIDAS — généré par Newbi",
    {
      color: MUTED,
      size: 9,
    },
  );
  drawText(`Édité le ${formatDate(new Date())}`, { color: MUTED, size: 9 });

  // Document
  sectionTitle("Document");
  drawField("Référence", meta.documentNumber || sig?.title || "—");
  if (meta.companyName) drawField("Émetteur", meta.companyName);
  drawField("Type de signature", sig.certificateType || "—");
  drawField("État", sig.state === "DONE" ? "Signé" : sig.state || "—");
  if (signed.createdAt) drawField("Signé le", formatDate(signed.createdAt));

  // Signataires
  sectionTitle(signers.length > 1 ? "Signataires" : "Signataire");
  signers.forEach((s, i) => {
    if (signers.length > 1) {
      drawText(`Signataire ${i + 1}`, { f: bold, size: 10 });
    }
    const fullName = [s.name, s.surname].filter(Boolean).join(" ");
    drawField("Nom", fullName || "—");
    if (s.email) drawField("Email", s.email);
    if (s.mobile) drawField("Mobile", s.mobile);
    if (Array.isArray(s.authentication) && s.authentication.length) {
      drawField("Authentification", s.authentication.join(", "));
    }
    const web = s.webValidation || {};
    const ip = web.otpIp || web.confirmIp;
    if (ip) drawField("Adresse IP", ip);
    if (web.lastOtpAt || web.lastConfirmAt) {
      drawField("Signé le", formatDate(web.lastOtpAt || web.lastConfirmAt));
    }
    y -= 6;
  });

  // Intégrité
  sectionTitle("Intégrité du document");
  if (input.sha256) drawField("Empreinte SHA-256 (original)", input.sha256);
  if (signed.sha256) drawField("Empreinte SHA-256 (signé)", signed.sha256);
  if (input.md5) drawField("Empreinte MD5 (original)", input.md5);
  drawText(
    "Toute modification du document signé invaliderait ces empreintes.",
    { color: MUTED, size: 8 },
  );

  // Journal d'audit
  if (auditLog.length) {
    sectionTitle("Journal d'audit");
    auditLog.forEach((entry) => {
      drawField(formatDate(entry.createdAt), entry.log || "");
    });
  }

  // Pied de page sur chaque page
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText(`Certificat généré par Newbi — page ${i + 1}/${pages.length}`, {
      x: MARGIN,
      y: MARGIN - 24,
      size: 8,
      font,
      color: MUTED,
    });
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

export default { buildProofCertificatePdf };
