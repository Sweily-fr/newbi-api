const { loadFilesSync } = require('@graphql-tools/load-files');
const { mergeTypeDefs } = require('@graphql-tools/merge');
const path = require('path');

// Charger d'abord le fichier de base
const baseTypes = loadFilesSync(path.join(__dirname, './types/base.graphql'));

// Charger ensuite les autres fichiers de schéma
const otherTypes = loadFilesSync([
  path.join(__dirname, './types/scalars.graphql'),
  path.join(__dirname, './types/enums.graphql'),
  path.join(__dirname, './types/objects.graphql'),
  path.join(__dirname, './types/inputs.graphql'),
  path.join(__dirname, './types/integration.graphql'),
  path.join(__dirname, './*.graphql')
]);

// Fusionner les schémas en s'assurant que les types de base sont traités en premier
const typeDefs = mergeTypeDefs([...baseTypes, ...otherTypes]);

module.exports = typeDefs;