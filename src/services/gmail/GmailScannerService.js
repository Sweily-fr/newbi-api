import GmailConnection from '../../models/GmailConnection.js';
import ProcessedEmail from '../../models/ProcessedEmail.js';
import ImportedInvoice from '../../models/ImportedInvoice.js';
import GmailOAuthProvider, { translateGmailError } from './GmailOAuthProvider.js';
import claudeVisionOcrService from '../claudeVisionOcrService.js';
import cloudflareService from '../cloudflareService.js';
import logger from '../../utils/logger.js';

// Mots-clés pour détecter les emails contenant des factures
const INVOICE_KEYWORDS = [
  'facture', 'invoice', 'reçu', 'receipt', 'avoir',
  'abonnement', 'subscription', 'paiement', 'payment',
  'note de frais', 'bon de commande', 'purchase order',
  'relevé', 'statement', 'debit', 'prélèvement'
];

const BATCH_SIZE = 10;
const MAX_MESSAGES = 500;

/**
 * Construit la query Gmail pour trouver les emails avec factures
 */
function buildGmailQuery(afterDate) {
  const keywordsQuery = INVOICE_KEYWORDS.map(k => `"${k}"`).join(' OR ');
  const dateFilter = `after:${afterDate.getFullYear()}/${String(afterDate.getMonth() + 1).padStart(2, '0')}/${String(afterDate.getDate()).padStart(2, '0')}`;
  return `(${keywordsQuery}) has:attachment filename:pdf ${dateFilter}`;
}

/**
 * Extrait les headers d'un message Gmail
 */
function extractHeaders(headers) {
  const result = {};
  for (const header of headers || []) {
    const name = header.name.toLowerCase();
    if (name === 'subject') result.subject = header.value;
    if (name === 'from') result.from = header.value;
    if (name === 'date') result.date = header.value;
  }
  return result;
}

/**
 * Parcourt récursivement les parts d'un message pour trouver les pièces jointes PDF
 */
function findPdfAttachments(parts, result = []) {
  if (!parts) return result;
  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      const mime = (part.mimeType || '').toLowerCase();
      if (mime === 'application/pdf' || mime === 'application/octet-stream' && part.filename.toLowerCase().endsWith('.pdf')) {
        result.push({
          filename: part.filename,
          mimeType: 'application/pdf',
          size: part.body.size || 0,
          attachmentId: part.body.attachmentId,
        });
      }
    }
    if (part.parts) {
      findPdfAttachments(part.parts, result);
    }
  }
  return result;
}

/**
 * Transforme les données OCR Claude Vision en données ImportedInvoice
 */
function transformOcrDataToInvoice(ocrResult) {
  const data = ocrResult.data || {};
  const vendor = data.vendor || {};
  const totals = data.totals || {};
  const paymentDetails = data.payment_details || {};
  const items = data.items || [];

  const paymentMethodMap = {
    card: 'CARD', cb: 'CARD', carte: 'CARD',
    cash: 'CASH', especes: 'CASH', espèces: 'CASH',
    check: 'CHECK', cheque: 'CHECK', chèque: 'CHECK',
    transfer: 'TRANSFER', virement: 'TRANSFER',
    direct_debit: 'DIRECT_DEBIT', prelevement: 'DIRECT_DEBIT', prélèvement: 'DIRECT_DEBIT',
  };

  const categoryMap = {
    OFFICE_SUPPLIES: 'OFFICE_SUPPLIES', TRAVEL: 'TRAVEL', MEALS: 'MEALS',
    EQUIPMENT: 'EQUIPMENT', MARKETING: 'MARKETING', TRAINING: 'TRAINING',
    SERVICES: 'SERVICES', RENT: 'RENT', SALARIES: 'SALARIES',
    UTILITIES: 'UTILITIES', INSURANCE: 'INSURANCE', SUBSCRIPTIONS: 'SUBSCRIPTIONS',
  };

  let invoiceDate = null;
  if (data.invoice_date) {
    try {
      invoiceDate = new Date(data.invoice_date);
      if (isNaN(invoiceDate.getTime())) invoiceDate = null;
    } catch { invoiceDate = null; }
  }

  let dueDate = null;
  if (data.due_date) {
    try {
      dueDate = new Date(data.due_date);
      if (isNaN(dueDate.getTime())) dueDate = null;
    } catch { dueDate = null; }
  }

  const rawMethod = (paymentDetails.method || '').toLowerCase().replace(/[^a-z_]/g, '');
  const category = categoryMap[data.category?.toUpperCase()] || 'OTHER';
  const paymentMethod = paymentMethodMap[rawMethod] || 'UNKNOWN';

  return {
    originalInvoiceNumber: data.invoice_number || null,
    vendor: {
      name: vendor.name || '',
      address: vendor.address || '',
      city: vendor.city || '',
      postalCode: vendor.postal_code || '',
      country: vendor.country || 'France',
      siret: vendor.siret || null,
      vatNumber: vendor.vat_number || null,
      email: vendor.email || null,
      phone: vendor.phone || null,
    },
    invoiceDate,
    dueDate,
    totalHT: parseFloat(totals.total_ht) || 0,
    totalVAT: parseFloat(totals.total_vat) || 0,
    totalTTC: parseFloat(totals.total_ttc) || 0,
    currency: data.currency || 'EUR',
    items: items.map(item => ({
      description: item.description || '',
      quantity: parseFloat(item.quantity) || 1,
      unitPrice: parseFloat(item.unit_price) || 0,
      totalPrice: parseFloat(item.total_price || item.total) || 0,
      vatRate: parseFloat(item.vat_rate) || 20,
    })),
    category,
    paymentMethod,
    ocrData: {
      extractedText: ocrResult.extractedText || '',
      rawData: data,
      confidence: 0.85,
      processedAt: new Date(),
    },
  };
}

/**
 * Scan la boîte Gmail d'une connexion et importe les factures trouvées
 */
export async function scanGmailConnection(connectionId, options = {}) {
  const { isInitialScan = false } = options;
  const connection = await GmailConnection.findById(connectionId);
  if (!connection || connection.status === 'disconnected') {
    throw new Error('Connexion Gmail introuvable ou déconnectée');
  }

  const provider = new GmailOAuthProvider();
  let scannedCount = 0;
  let invoicesFound = 0;
  let skippedCount = 0;

  try {
    // Update status to syncing
    connection.status = 'syncing';
    connection.lastSyncError = null;
    await connection.save();

    // Ensure valid token
    const accessToken = await provider.ensureValidToken(connection);
    const gmail = provider.getGmailClient(accessToken);

    // Calculate the date to scan from
    let afterDate;
    if (isInitialScan || !connection.lastSyncAt) {
      afterDate = new Date();
      afterDate.setMonth(afterDate.getMonth() - connection.scanPeriodMonths);
    } else {
      // Incremental: scan last 24h with some overlap
      afterDate = new Date(connection.lastSyncAt.getTime() - 2 * 60 * 60 * 1000);
    }

    const query = buildGmailQuery(afterDate);
    logger.info(`[Gmail Scan] Connexion ${connection.accountEmail} — query: ${query.substring(0, 100)}...`);

    // Fetch message IDs
    let allMessageIds = [];
    let pageToken = null;
    do {
      const listParams = {
        userId: 'me',
        q: query,
        maxResults: Math.min(MAX_MESSAGES - allMessageIds.length, 100),
      };
      if (pageToken) listParams.pageToken = pageToken;

      const listRes = await gmail.users.messages.list(listParams);
      const messages = listRes.data.messages || [];
      allMessageIds.push(...messages.map(m => m.id));
      pageToken = listRes.data.nextPageToken;
    } while (pageToken && allMessageIds.length < MAX_MESSAGES);

    logger.info(`[Gmail Scan] ${allMessageIds.length} emails trouvés pour ${connection.accountEmail}`);

    if (allMessageIds.length === 0) {
      connection.status = 'active';
      connection.lastSyncAt = new Date();
      await connection.save();
      return { success: true, scannedCount: 0, invoicesFound: 0, skippedCount: 0, message: 'Aucun email trouvé' };
    }

    // Filter already processed
    const alreadyProcessed = await ProcessedEmail.find({
      workspaceId: connection.workspaceId,
      gmailMessageId: { $in: allMessageIds },
    }).select('gmailMessageId').lean();

    const processedSet = new Set(alreadyProcessed.map(p => p.gmailMessageId));
    const newMessageIds = allMessageIds.filter(id => !processedSet.has(id));
    skippedCount = allMessageIds.length - newMessageIds.length;

    logger.info(`[Gmail Scan] ${newMessageIds.length} nouveaux emails à traiter (${skippedCount} déjà traités)`);

    // Process in batches
    for (let i = 0; i < newMessageIds.length; i += BATCH_SIZE) {
      const batch = newMessageIds.slice(i, i + BATCH_SIZE);

      for (const messageId of batch) {
        try {
          const result = await processGmailMessage(
            gmail, messageId, connection, provider
          );
          scannedCount++;
          if (result.invoicesCreated > 0) {
            invoicesFound += result.invoicesCreated;
          }
        } catch (msgError) {
          logger.error(`[Gmail Scan] Erreur traitement message ${messageId}:`, msgError.message);
          scannedCount++;
          // Record the error
          try {
            await ProcessedEmail.create({
              workspaceId: connection.workspaceId,
              userId: connection.userId,
              gmailConnectionId: connection._id,
              gmailMessageId: messageId,
              status: 'error',
              errorMessage: msgError.message,
            });
          } catch (saveErr) {
            if (saveErr.code !== 11000) {
              logger.error(`[Gmail Scan] Erreur sauvegarde ProcessedEmail:`, saveErr.message);
            }
          }
        }
      }

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < newMessageIds.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Update connection stats
    connection.status = 'active';
    connection.lastSyncAt = new Date();
    connection.totalEmailsScanned += scannedCount;
    connection.totalInvoicesFound += invoicesFound;
    await connection.save();

    logger.info(`[Gmail Scan] Terminé pour ${connection.accountEmail}: ${scannedCount} emails, ${invoicesFound} factures trouvées`);

    return {
      success: true,
      scannedCount,
      invoicesFound,
      skippedCount,
      message: `${invoicesFound} facture(s) trouvée(s) sur ${scannedCount} email(s) analysé(s)`
    };

  } catch (error) {
    logger.error(`[Gmail Scan] Erreur pour ${connection.accountEmail}:`, error.message);

    // Update connection status based on error type
    const msg = error.message || '';
    if (msg.includes('invalid_grant') || msg.includes('Token has been expired') || error.code === 401) {
      connection.status = 'expired';
    } else {
      connection.status = 'error';
    }
    connection.lastSyncError = translateGmailError(error);
    await connection.save();

    return {
      success: false,
      scannedCount,
      invoicesFound,
      skippedCount,
      message: translateGmailError(error)
    };
  }
}

/**
 * Traite un message Gmail unique : extrait les PDFs, OCR, et crée les ImportedInvoice
 */
async function processGmailMessage(gmail, messageId, connection) {
  // Fetch full message
  const msgRes = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const message = msgRes.data;
  const headers = extractHeaders(message.payload?.headers);
  const pdfAttachments = findPdfAttachments(message.payload?.parts || [message.payload]);

  const invoiceAttachments = [];
  let invoicesCreated = 0;

  for (const attachment of pdfAttachments) {
    try {
      // Download attachment data
      const attRes = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachment.attachmentId,
      });

      const base64Data = attRes.data.data
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      const buffer = Buffer.from(base64Data, 'base64');

      // Upload to Cloudflare R2
      const uploadResult = await cloudflareService.uploadImage(
        buffer,
        attachment.filename,
        connection.userId.toString(),
        'importedInvoice',
        connection.workspaceId.toString()
      );

      if (!uploadResult?.url) {
        logger.warn(`[Gmail Scan] Échec upload Cloudflare pour ${attachment.filename}`);
        continue;
      }

      // OCR with Claude Vision
      let ocrResult;
      try {
        ocrResult = await claudeVisionOcrService.processFromBase64(
          base64Data,
          'application/pdf',
          attachment.filename
        );
      } catch (ocrError) {
        logger.warn(`[Gmail Scan] OCR échoué pour ${attachment.filename}: ${ocrError.message}`);
        // Still create the invoice with minimal data
        ocrResult = {
          success: false,
          extractedText: '',
          data: {},
        };
      }

      // Transform OCR data
      const invoiceData = transformOcrDataToInvoice(ocrResult);

      // Check for duplicates
      const duplicates = await ImportedInvoice.findPotentialDuplicates(
        connection.workspaceId,
        invoiceData.originalInvoiceNumber,
        invoiceData.vendor?.name,
        invoiceData.totalTTC
      );
      const isDuplicate = duplicates.length > 0;

      // Create ImportedInvoice
      const importedInvoice = new ImportedInvoice({
        workspaceId: connection.workspaceId,
        importedBy: connection.userId,
        status: 'PENDING_REVIEW',
        source: 'GMAIL',
        gmailMessageId: messageId,
        ...invoiceData,
        file: {
          url: uploadResult.url,
          cloudflareKey: uploadResult.key,
          originalFileName: attachment.filename,
          mimeType: 'application/pdf',
          fileSize: buffer.length,
        },
        isDuplicate,
        duplicateOf: isDuplicate ? duplicates[0]._id : null,
      });

      await importedInvoice.save();
      invoicesCreated++;

      invoiceAttachments.push({
        filename: attachment.filename,
        mimeType: 'application/pdf',
        size: buffer.length,
        importedInvoiceId: importedInvoice._id,
      });

    } catch (attError) {
      logger.error(`[Gmail Scan] Erreur pièce jointe ${attachment.filename}:`, attError.message);
      invoiceAttachments.push({
        filename: attachment.filename,
        mimeType: 'application/pdf',
        size: attachment.size,
        importedInvoiceId: null,
      });
    }
  }

  // Record processed email
  await ProcessedEmail.create({
    workspaceId: connection.workspaceId,
    userId: connection.userId,
    gmailConnectionId: connection._id,
    gmailMessageId: messageId,
    gmailThreadId: message.threadId,
    subject: headers.subject || '',
    from: headers.from || '',
    receivedAt: headers.date ? new Date(headers.date) : null,
    hasInvoice: invoicesCreated > 0,
    attachmentCount: pdfAttachments.length,
    invoiceAttachments,
    status: 'processed',
  });

  return { invoicesCreated };
}

/**
 * Scanne toutes les connexions Gmail actives
 */
export async function scanAllActiveConnections() {
  const connections = await GmailConnection.find({
    status: { $in: ['active'] },
    isActive: true,
  });

  logger.info(`[Gmail Sync] ${connections.length} connexion(s) active(s) à synchroniser`);

  let successCount = 0;
  let failCount = 0;

  for (const connection of connections) {
    try {
      const result = await scanGmailConnection(connection._id);
      if (result.success) {
        successCount++;
      } else {
        failCount++;
      }
    } catch (error) {
      logger.error(`[Gmail Sync] Erreur sync ${connection.accountEmail}:`, error.message);
      failCount++;
    }

    // 2 second delay between connections to avoid rate limiting
    if (connections.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return { total: connections.length, successCount, failCount };
}
