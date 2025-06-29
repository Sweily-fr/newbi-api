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
import kanbanResolvers from "./kanban.js";
import stripeConnectResolvers from "./stripeConnectResolvers.js";

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
  kanbanResolvers,
  stripeConnectResolvers,
]);

export default resolvers;
