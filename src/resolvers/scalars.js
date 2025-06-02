const { GraphQLScalarType } = require('graphql');
const { GraphQLUpload } = require('graphql-upload');
const { Kind } = require('graphql/language');

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

// Résolveur pour le type scalaire DateTime
const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  description: 'Le type scalaire DateTime représente une date et une heure au format ISO-8601',
  
  // Conversion des dates en chaînes ISO pour le client
  serialize(value) {
    if (value instanceof Date) {
      return value.toISOString();
    }
    return value;
  },
  
  // Analyse des chaînes ISO reçues du client
  parseValue(value) {
    return new Date(value);
  },
  
  // Analyse des littéraux de date dans les requêtes GraphQL
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING) {
      return new Date(ast.value);
    }
    return null;
  }
});

module.exports = {
  JSON: JSONScalar,
  Upload: GraphQLUpload,
  DateTime: DateTimeScalar
};
