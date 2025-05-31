const { GraphQLScalarType } = require('graphql');
const { GraphQLUpload } = require('graphql-upload');

// Fonction récursive pour analyser les littéraux JSON
const parseLiteralHelper = (ast) => {
  switch (ast.kind) {
    case 'StringValue':
      return JSON.parse(ast.value);
    case 'ObjectValue':
      return ast.fields.reduce((obj, field) => {
        obj[field.name.value] = parseLiteralHelper(field.value);
        return obj;
      }, {});
    case 'IntValue':
      return parseInt(ast.value, 10);
    case 'FloatValue':
      return parseFloat(ast.value);
    case 'BooleanValue':
      return ast.value;
    case 'NullValue':
      return null;
    case 'ListValue':
      return ast.values.map(parseLiteralHelper);
    default:
      return null;
  }
};

// Résolveur pour le type scalaire JSON
const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Le type scalaire JSON représente des données JSON arbitraires',
  
  // Conversion des valeurs JSON en chaînes pour le client
  serialize(value) {
    return value;
  },
  
  // Analyse des valeurs JSON reçues du client
  parseValue(value) {
    return value;
  },
  
  // Analyse des littéraux JSON dans les requêtes GraphQL
  parseLiteral(ast) {
    return parseLiteralHelper(ast);
  }
});

module.exports = {
  JSON: JSONScalar,
  Upload: GraphQLUpload
};
