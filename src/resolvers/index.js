import { mergeResolvers } from "@graphql-tools/merge";
import { clearPendingSubscriptionCheck } from "../middlewares/rbac.js";
import userResolvers from "./user.js";
import subscriptionResolvers from "./subscription.js";
import invoiceResolvers from "./invoice.js";
import quoteResolvers from "./quote.js";
import creditNoteResolvers from "./creditNote.js";
import clientResolvers from "./client.js";
import productResolvers from "./product.js";
import companySearchResolvers from "./companySearch.js";
import emailSignatureResolvers from "./emailSignature.js";
import emailSignatureV2Resolvers from "./emailSignatureV2.js";
import integrationResolvers from "./integration.js";
import documentSettingsResolvers from "./documentSettings.js";
import expenseResolvers from "./expense.js";
import scalarResolvers from "./scalars.js";
import fileTransferResolvers from "./fileTransfer.js";
import stripeConnectResolvers from "./stripeConnectResolvers.js";
import kanbanResolvers from "./kanban.js";
import kanbanTemplateResolvers from "./kanbanTemplate.js";
import invoiceTemplateResolvers from "./invoiceTemplate.js";
import quoteTemplateResolvers from "./quoteTemplate.js";
import purchaseOrderTemplateResolvers from "./purchaseOrderTemplate.js";
import chunkUploadResolvers from "./chunkUpload.js";
import chunkUploadR2Resolvers from "./chunkUploadR2.js";
import imageUploadResolvers from "./imageUpload.js";
import documentUploadResolvers from "./documentUpload.js";
import documentAnnexResolvers from "./documentAnnex.js";
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
import eInvoicingResolvers from "./eInvoicing.js";
import publicBoardShareResolvers from "./publicBoardShare.js";
import taskImageResolvers from "./taskImage.js";
import notificationPreferencesResolvers from "./notificationPreferences.js";
import pushTokenResolvers from "./pushToken.js";
import userInvitedResolvers from "./userInvited.js";
import clientAutomationResolvers from "./clientAutomation.js";
import { clientCustomFieldResolvers } from "./clientCustomField.js";
import { productCustomFieldResolvers } from "./productCustomField.js";
import clientSegmentResolvers from "./clientSegment.js";
import crmEmailAutomationResolvers from "./crmEmailAutomation.js";
import notificationResolvers from "./notification.js";
import calendarConnectionResolvers from "./calendarConnection.js";
import gmailConnectionResolvers from "./gmailConnection.js";
import calendarColorLabelsResolvers from "./calendarColorLabels.js";
import calendarLinkedItemsResolvers from "./calendarLinkedItems.js";
import calendarFeedResolvers from "./calendarFeed.js";
import documentAutomationResolvers from "./documentAutomation.js";
import purchaseInvoiceResolvers from "./purchaseInvoice.js";
import treasuryForecastResolvers from "./treasuryForecast.js";
import purchaseOrderResolvers from "./purchaseOrder.js";
import deliveryNoteResolvers from "./deliveryNote.js";
import importedPurchaseOrderResolvers from "./importedPurchaseOrder.js";
import financialAnalyticsResolvers from "./financialAnalytics.js";
import pennylaneResolvers from "./pennylaneResolvers.js";
import qontoResolvers from "./qontoResolvers.js";
import abbyResolvers from "./abbyResolvers.js";
import installedAppResolvers from "./installedApp.js";
import esignatureResolvers from "./esignatureResolvers.js";
import rgpdResolvers from "./rgpd.js";
import dashboardAggregationResolvers from "./dashboardAggregation.js";
import receiptMatchingResolvers from "./receiptMatchingResolvers.js";
import organizationRoleResolvers from "./organizationRole.js";
import invoiceRecurrenceResolvers from "./invoiceRecurrence.js";
import socialPublishingResolvers from "./socialPublishing.js";
import appointmentsResolvers from "./appointments.js";

const resolvers = mergeResolvers([
  userResolvers,
  subscriptionResolvers,
  invoiceResolvers,
  invoiceRecurrenceResolvers,
  quoteResolvers,
  creditNoteResolvers,
  clientResolvers,
  clientListResolvers,
  productResolvers,
  companySearchResolvers,
  emailSignatureResolvers,
  emailSignatureV2Resolvers,
  integrationResolvers,
  documentSettingsResolvers,
  expenseResolvers,
  scalarResolvers,
  fileTransferResolvers,
  stripeConnectResolvers,
  kanbanResolvers,
  kanbanTemplateResolvers,
  invoiceTemplateResolvers,
  quoteTemplateResolvers,
  purchaseOrderTemplateResolvers,
  chunkUploadResolvers,
  chunkUploadR2Resolvers,
  imageUploadResolvers,
  documentUploadResolvers,
  documentAnnexResolvers,
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
  eInvoicingResolvers,
  publicBoardShareResolvers,
  taskImageResolvers,
  notificationPreferencesResolvers,
  pushTokenResolvers,
  userInvitedResolvers,
  clientAutomationResolvers,
  clientCustomFieldResolvers,
  productCustomFieldResolvers,
  clientSegmentResolvers,
  crmEmailAutomationResolvers,
  notificationResolvers,
  calendarConnectionResolvers,
  gmailConnectionResolvers,
  calendarColorLabelsResolvers,
  calendarLinkedItemsResolvers,
  calendarFeedResolvers,
  documentAutomationResolvers,
  purchaseInvoiceResolvers,
  treasuryForecastResolvers,
  purchaseOrderResolvers,
  deliveryNoteResolvers,
  importedPurchaseOrderResolvers,
  financialAnalyticsResolvers,
  pennylaneResolvers,
  qontoResolvers,
  abbyResolvers,
  installedAppResolvers,
  esignatureResolvers,
  rgpdResolvers,
  dashboardAggregationResolvers,
  receiptMatchingResolvers,
  organizationRoleResolvers,
  socialPublishingResolvers,
  appointmentsResolvers,
]);

// Contrôle d'abonnement différé (checkSubscriptionActive) : propre à chaque
// mutation, jamais repris par la suivante d'une même opération
resolvers.Mutation = Object.fromEntries(
  Object.entries(resolvers.Mutation || {}).map(([name, fn]) => [
    name,
    typeof fn === "function"
      ? (parent, args, context, info) => {
          clearPendingSubscriptionCheck(context);
          return fn(parent, args, context, info);
        }
      : fn,
  ]),
);

export default resolvers;
