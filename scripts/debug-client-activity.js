import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Client from '../src/models/Client.js';
import CreditNote from '../src/models/CreditNote.js';

dotenv.config();

async function debugClientActivity() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    // Récupérer tous les clients
    const clients = await Client.find().select('_id name email workspaceId');
    console.log(`\n📋 Nombre de clients dans la base: ${clients.length}`);
    
    if (clients.length > 0) {
      console.log('\n👥 Liste des clients:');
      clients.forEach(client => {
        console.log(`  - ${client.name} (${client.email}) - Workspace: ${client.workspaceId}`);
      });
    }

    // Récupérer tous les avoirs
    const creditNotes = await CreditNote.find().select('_id prefix number client.email client.name workspaceId');
    console.log(`\n📄 Nombre d'avoirs dans la base: ${creditNotes.length}`);
    
    if (creditNotes.length > 0) {
      console.log('\n💰 Liste des avoirs:');
      creditNotes.forEach(cn => {
        console.log(`  - ${cn.prefix}${cn.number} - Client: ${cn.client.name} (${cn.client.email}) - Workspace: ${cn.workspaceId}`);
        
        // Vérifier si le client existe dans la collection Client
        const clientExists = clients.find(c => 
          c.email === cn.client.email && 
          c.workspaceId.toString() === cn.workspaceId.toString()
        );
        
        if (clientExists) {
          console.log(`    ✅ Client trouvé dans la collection Client (ID: ${clientExists._id})`);
        } else {
          console.log(`    ⚠️ Client NON trouvé dans la collection Client`);
        }
      });
    }

    // Vérifier les activités des clients
    console.log('\n🔍 Vérification des activités des clients:');
    for (const client of clients) {
      const fullClient = await Client.findById(client._id);
      const creditNoteActivities = fullClient.activity.filter(a => a.type === 'credit_note_created');
      
      if (creditNoteActivities.length > 0) {
        console.log(`\n  Client: ${fullClient.name}`);
        console.log(`  Activités d'avoirs: ${creditNoteActivities.length}`);
        creditNoteActivities.forEach(activity => {
          console.log(`    - ${activity.description}`);
          console.log(`      Metadata:`, activity.metadata);
        });
      }
    }

  } catch (error) {
    console.error('❌ Erreur:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Déconnecté de MongoDB');
  }
}

debugClientActivity();
