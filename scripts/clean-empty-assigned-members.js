import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger les variables d'environnement
dotenv.config({ path: path.join(__dirname, '../.env') });

// Connexion à MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connecté à MongoDB');
  } catch (error) {
    console.error('❌ Erreur de connexion MongoDB:', error);
    process.exit(1);
  }
};

// Nettoyer les assignedMember vides ou incomplets et ajouter expenseType par défaut
const cleanEmptyAssignedMembers = async () => {
  try {
    const Expense = mongoose.model('Expense', new mongoose.Schema({}, { strict: false }));
    
    // 1. Nettoyer les assignedMember vides
    const expensesWithMember = await Expense.find({ assignedMember: { $exists: true } });
    console.log(`📊 ${expensesWithMember.length} dépenses avec assignedMember trouvées`);
    
    let cleaned = 0;
    for (const expense of expensesWithMember) {
      const member = expense.assignedMember;
      if (!member || !member.userId || member.userId === null || member.userId === '') {
        console.log(`🧹 Nettoyage dépense ${expense._id}: assignedMember vide`);
        await Expense.updateOne(
          { _id: expense._id },
          { $set: { assignedMember: null } }
        );
        cleaned++;
      }
    }
    console.log(`✅ ${cleaned} assignedMember nettoyés`);
    
    // 2. Ajouter expenseType par défaut aux dépenses qui n'en ont pas
    const expensesWithoutType = await Expense.find({ 
      $or: [
        { expenseType: { $exists: false } },
        { expenseType: null }
      ]
    });
    console.log(`📊 ${expensesWithoutType.length} dépenses sans expenseType trouvées`);
    
    let updated = 0;
    for (const expense of expensesWithoutType) {
      console.log(`🔧 Ajout expenseType=ORGANIZATION à dépense ${expense._id}`);
      await Expense.updateOne(
        { _id: expense._id },
        { $set: { expenseType: 'ORGANIZATION' } }
      );
      updated++;
    }
    console.log(`✅ ${updated} expenseType ajoutés`);
    
  } catch (error) {
    console.error('❌ Erreur lors du nettoyage:', error);
  }
};

// Exécuter le script
const run = async () => {
  await connectDB();
  await cleanEmptyAssignedMembers();
  await mongoose.connection.close();
  console.log('✅ Script terminé');
  process.exit(0);
};

run();
