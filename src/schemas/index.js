import { loadFilesSync } from '@graphql-tools/load-files';
import { mergeTypeDefs } from '@graphql-tools/merge';
import path from 'path';
import { fileURLToPath } from 'url';

// Recréer __dirname pour ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger d'abord le fichier de base
const baseTypes = loadFilesSync(path.join(__dirname, './types/base.graphql'));

// Charger ensuite les autres fichiers de schéma
const otherTypes = loadFilesSync([
  path.join(__dirname, './types/scalars.graphql'),
  path.join(__dirname, './types/enums.graphql'),
  path.join(__dirname, './types/objects.graphql'),
  path.join(__dirname, './types/inputs.graphql'),
  path.join(__dirname, './types/integration.graphql'),
  path.join(__dirname, './types/fileTransfer.graphql'), // Chargement explicite du schéma fileTransfer
  path.join(__dirname, './types/chunkUpload.graphql'),  // Chargement explicite du schéma chunkUpload
  path.join(__dirname, './*.graphql'),
]);

// NOTE: Les fichiers typeDefs/*.js ne sont plus chargés car ils ont été migrés vers des fichiers .graphql
// et causent des conflits de types (notamment pour le type File avec size: Float vs Int)
// const typeDefsFiles = loadFilesSync(path.join(__dirname, '../typeDefs/*.js'));

// Fusionner les schémas en s'assurant que les types de base sont traités en premier
const typeDefs = mergeTypeDefs([...baseTypes, ...otherTypes]);

export default typeDefs;