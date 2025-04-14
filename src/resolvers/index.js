const { mergeResolvers } = require('@graphql-tools/merge');
const userResolvers = require('./user');
const invoiceResolvers = require('./invoice');
const quoteResolvers = require('./quote');
const clientResolvers = require('./client');
const productResolvers = require('./product');
const contactResolvers = require('./contact');
const companySearchResolvers = require('./companySearch');
const emailSignatureResolvers = require('./emailSignature');

const resolvers = mergeResolvers([
  userResolvers,
  invoiceResolvers,
  quoteResolvers,
  clientResolvers,
  productResolvers,
  contactResolvers,
  companySearchResolvers,
  emailSignatureResolvers
]);

module.exports = resolvers;
