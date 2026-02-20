import { mergeResolvers } from "@graphql-tools/merge";
import userResolvers from "./user.js";
import invoiceResolvers from "./invoice.js";
import quoteResolvers from "./quote.js";
import creditNoteResolvers from "./creditNote.js";
import clientResolvers from "./client.js";
import productResolvers from "./product.js";
import contactResolvers from "./contact.js";
import companySearchResolvers from "./companySearch.js";
import emailSignatureResolvers from "./emailSignature.js";
import integrationResolvers from "./integration.js";
import documentSettingsResolvers from "./documentSettings.js";
import expenseResolvers from "./expense.js";
import scalarResolvers from "./scalars.js";
import fileTransferResolvers from "./fileTransfer.js";
import stripeConnectResolvers from "./stripeConnectResolvers.js";
import kanbanResolvers from "./kanban.js";
import kanbanTemplateResolvers from "./kanbanTemplate.js";
import chunkUploadResolvers from "./chunkUpload.js";
import chunkUploadR2Resolvers from "./chunkUploadR2.js";
import imageUploadResolvers from "./imageUpload.js";
import documentUploadResolvers from "./documentUpload.js";
import ocrResolvers from "./ocr.js";
import eventResolvers from "./event.js";
import emailReminderResolvers from "./emailReminder.js";
import bankingResolvers from "./banking.js";
import communitySuggestionResolvers from "./communitySuggestion.js";
import blogResolvers from "./blog.js";
import { clientListResolvers } from "./clientList.js";
import partnerResolvers from "./partner.js";
import emailSettingsResolvers from "./emailSettings.js";
import invoiceReminderSettingsResolvers from "./invoiceReminderSettings.js";
import documentEmailResolvers from "./documentEmail.js";
import importedInvoiceResolvers from "./importedInvoice.js";
import importedQuoteResolvers from "./importedQuote.js";
import reconciliationResolvers from "./reconciliationResolvers.js";
import sharedDocumentResolvers from "./sharedDocument.js";
// DÉSACTIVÉ: SuperPDP API pas encore active
// import eInvoicingResolvers from "./eInvoicing.js";
import publicBoardShareResolvers from "./publicBoardShare.js";
import taskImageResolvers from "./taskImage.js";
import notificationPreferencesResolvers from "./notificationPreferences.js";
import userInvitedResolvers from "./userInvited.js";
import clientAutomationResolvers from "./clientAutomation.js";
import { clientCustomFieldResolvers } from "./clientCustomField.js";
import clientSegmentResolvers from "./clientSegment.js";
import crmEmailAutomationResolvers from "./crmEmailAutomation.js";
import notificationResolvers from "./notification.js";
import calendarConnectionResolvers from "./calendarConnection.js";
import documentAutomationResolvers from "./documentAutomation.js";
import purchaseInvoiceResolvers from "./purchaseInvoice.js";
import treasuryForecastResolvers from "./treasuryForecast.js";
import purchaseOrderResolvers from "./purchaseOrder.js";
import importedPurchaseOrderResolvers from "./importedPurchaseOrder.js";

const resolvers = mergeResolvers([
  userResolvers,
  invoiceResolvers,
  quoteResolvers,
  creditNoteResolvers,
  clientResolvers,
  clientListResolvers,
  productResolvers,
  contactResolvers,
  companySearchResolvers,
  emailSignatureResolvers,
  integrationResolvers,
  documentSettingsResolvers,
  expenseResolvers,
  scalarResolvers,
  fileTransferResolvers,
  stripeConnectResolvers,
  kanbanResolvers,
  kanbanTemplateResolvers,
  chunkUploadResolvers,
  chunkUploadR2Resolvers,
  imageUploadResolvers,
  documentUploadResolvers,
  ocrResolvers,
  eventResolvers,
  emailReminderResolvers,
  bankingResolvers,
  communitySuggestionResolvers,
  blogResolvers,
  partnerResolvers,
  emailSettingsResolvers,
  invoiceReminderSettingsResolvers,
  documentEmailResolvers,
  importedInvoiceResolvers,
  importedQuoteResolvers,
  reconciliationResolvers,
  sharedDocumentResolvers,
  // DÉSACTIVÉ: SuperPDP API pas encore active
  // eInvoicingResolvers,
  publicBoardShareResolvers,
  taskImageResolvers,
  notificationPreferencesResolvers,
  userInvitedResolvers,
  clientAutomationResolvers,
  clientCustomFieldResolvers,
  clientSegmentResolvers,
  crmEmailAutomationResolvers,
  notificationResolvers,
  calendarConnectionResolvers,
  documentAutomationResolvers,
  purchaseInvoiceResolvers,
  treasuryForecastResolvers,
  purchaseOrderResolvers,
  importedPurchaseOrderResolvers,
]);

export default resolvers;
