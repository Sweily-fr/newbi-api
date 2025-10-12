import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger la configuration depuis ecosystem.config.cjs
let config;
try {
  const ecosystemPath = resolve(__dirname, '../ecosystem.config.cjs');
  const ecosystemModule = await import(`file://${ecosystemPath}`);
  config = ecosystemModule.default || ecosystemModule;
} catch (error) {
  console.error('❌ Erreur chargement ecosystem.config.cjs:', error.message);
  process.exit(1);
}

const MONGODB_URI = config.apps[0].env_production.MONGODB_URI;

// Connexion MongoDB
await mongoose.connect(MONGODB_URI);

console.log('✅ Connecté à MongoDB\n');

// Récupérer l'utilisateur problématique
const userId = '68cd422bae6d99144724d8b6';

const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }), 'user');

const user = await User.findById(userId);

if (!user) {
  console.log('❌ Utilisateur non trouvé');
} else {
  console.log('📋 Informations utilisateur:');
  console.log('  - ID:', user._id);
  console.log('  - Email:', user.email);
  console.log('  - Name:', user.name);
  console.log('  - workspaceId:', user.workspaceId || '❌ MANQUANT');
  console.log('  - isDisabled:', user.isDisabled || false);
  console.log('\n📦 Objet complet:');
  console.log(JSON.stringify(user.toObject(), null, 2));
}

await mongoose.disconnect();
console.log('\n✅ Déconnecté de MongoDB');
