import { loadFilesSync } from '@graphql-tools/load-files';
import { mergeTypeDefs } from '@graphql-tools/merge';
import path from 'path';
import { fileURLToPath } from 'url';

// Pour remplacer __dirname dans ES modules
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
  path.join(__dirname, './*.graphql')
]);

// Charger les définitions de types du dossier typeDefs
const typeDefsFiles = loadFilesSync(path.join(__dirname, '../typeDefs/*.js'));

// Fusionner les schémas en s'assurant que les types de base sont traités en premier
const typeDefs = mergeTypeDefs([...baseTypes, ...otherTypes, ...typeDefsFiles]);

export default typeDefs;