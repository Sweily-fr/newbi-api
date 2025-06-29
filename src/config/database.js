import mongoose from 'mongoose';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';

dotenv.config();

let mongoClient;

/**
 * Fonction pour se connecter à MongoDB
 * @returns {Promise<MongoClient>} Le client MongoDB
 */
async function connectDB() {
  try {
    const uri = process.env.MONGODB_URI;
    logger.info("URI MongoDB:", uri ? "Définie" : "Non définie");

    if (!uri) {
      throw new Error(
        "La variable d'environnement MONGODB_URI n'est pas définie"
      );
    }

    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    mongoClient = mongoose.connection.getClient(); // Obtenir le client MongoDB natif
    logger.info("MongoDB connected");
    return mongoClient;
  } catch (err) {
    logger.error("Erreur de connexion MongoDB:", err.message);
    process.exit(1);
  }
}

// Exporter le client MongoDB et la fonction de connexion
export const client = () => mongoClient;
export const connect = connectDB;
export default { client, connect };
