import { mergeResolvers } from "@graphql-tools/merge";
import userResolvers from "./user.js";
import invoiceResolvers from "./invoice.js";
import quoteResolvers from "./quote.js";

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
import chunkUploadResolvers from "./chunkUpload.js";
import imageUploadResolvers from "./imageUpload.js";
import documentUploadResolvers from "./documentUpload.js";
import ocrResolvers from "./ocr.js";
import eventResolvers from "./event.js";
import bankingResolvers from "./banking.js";

const resolvers = mergeResolvers([
  userResolvers,
  invoiceResolvers,
  quoteResolvers,

  clientResolvers,
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
  chunkUploadResolvers,
  imageUploadResolvers,
  documentUploadResolvers,
  ocrResolvers,
  eventResolvers,
  bankingResolvers,
]);

export default resolvers;
