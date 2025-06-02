const { mergeResolvers } = require('@graphql-tools/merge');
const userResolvers = require('./user');
const invoiceResolvers = require('./invoice');
const quoteResolvers = require('./quote');
const purchaseOrderResolvers = require('./purchaseOrder');
const clientResolvers = require('./client');
const productResolvers = require('./product');
const contactResolvers = require('./contact');
const companySearchResolvers = require('./companySearch');
const emailSignatureResolvers = require('./emailSignature');
const integrationResolvers = require('./integration');
const documentSettingsResolvers = require('./documentSettings');
const expenseResolvers = require('./expense');
const scalarResolvers = require('./scalars');

const resolvers = mergeResolvers([
  userResolvers,
  invoiceResolvers,
  quoteResolvers,
  purchaseOrderResolvers,
  clientResolvers,
  productResolvers,
  contactResolvers,
  companySearchResolvers,
  emailSignatureResolvers,
  integrationResolvers,
  documentSettingsResolvers,
  expenseResolvers,
  scalarResolvers
]);

module.exports = resolvers;
