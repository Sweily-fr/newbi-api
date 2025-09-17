import jwt from "jsonwebtoken";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import User from "../models/User.js";

// Cache pour les clés JWKS
let jwksCache = null;
let jwksCacheExpiry = 0;

/**
 * Middleware d'authentification utilisant les JWT Better Auth
 * Valide les JWT via JWKS endpoint
 */
const betterAuthJWTMiddleware = async (req) => {
  try {
    // Récupérer le token JWT depuis les headers
    const token = extractJWTToken(req.headers);
    if (!token) {
      return null;
    }

    // Décoder le header pour récupérer le kid (key ID)
    const decodedHeader = jwt.decode(token, { complete: true });
    if (!decodedHeader?.header?.kid) {
      logger.debug("JWT sans kid dans le header");
      return null;
    }

    // Récupérer les clés JWKS
    const jwks = await getJWKS();
    if (!jwks) {
      logger.error("Impossible de récupérer les clés JWKS");
      return null;
    }

    // Trouver la clé correspondante au kid
    const key = jwks.keys.find(k => k.kid === decodedHeader.header.kid);
    if (!key) {
      logger.debug(`Clé JWKS non trouvée pour kid: ${decodedHeader.header.kid}`);
      return null;
    }

    // Convertir la clé JWKS en format utilisable
    const publicKey = await jwkToPem(key);
    
    // Vérifier et décoder le JWT
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['EdDSA'], // Better Auth utilise Ed25519
      issuer: process.env.FRONTEND_URL || 'http://localhost:3000',
    });

    // Récupérer l'utilisateur depuis la base de données
    const user = await User.findById(decoded.sub);
    if (!user || user.isDisabled) {
      logger.debug("Utilisateur non trouvé ou désactivé");
      return null;
    }

    logger.debug(`JWT Better Auth valide pour: ${user.email}`);
    return user;

  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logger.debug("JWT Better Auth expiré");
    } else if (error instanceof jwt.JsonWebTokenError) {
      logger.debug("JWT Better Auth invalide:", error.message);
    } else {
      logger.error("Erreur validation JWT Better Auth:", error.message);
    }
    return null;
  }
};

/**
 * Récupère les clés JWKS depuis Better Auth
 */
const getJWKS = async () => {
  try {
    // Vérifier le cache
    const now = Date.now();
    if (jwksCache && now < jwksCacheExpiry) {
      return jwksCache;
    }

    // Récupérer les clés depuis l'endpoint JWKS
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const response = await fetch(`${frontendUrl}/api/auth/jwks`, {
      timeout: 5000,
    });

    if (!response.ok) {
      throw new Error(`Erreur JWKS: ${response.status}`);
    }

    const jwks = await response.json();
    
    // Mettre en cache pour 24 heures (les clés changent rarement)
    jwksCache = jwks;
    jwksCacheExpiry = now + (24 * 60 * 60 * 1000);

    return jwks;
  } catch (error) {
    logger.error("Erreur récupération JWKS:", error.message);
    return null;
  }
};

/**
 * Convertit une clé JWK en format PEM
 */
const jwkToPem = async (jwk) => {
  try {
    // Pour Ed25519, on utilise la bibliothèque crypto native
    const crypto = await import('crypto');
    
    if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
      // Décoder la clé publique x depuis base64url
      const publicKeyBytes = Buffer.from(jwk.x, 'base64url');
      
      // Créer l'objet clé publique
      const publicKey = crypto.createPublicKey({
        key: {
          kty: 'OKP',
          crv: 'Ed25519',
          x: jwk.x,
        },
        format: 'jwk',
      });

      return publicKey;
    }
    
    throw new Error(`Type de clé JWK non supporté: ${jwk.kty}`);
  } catch (error) {
    logger.error("Erreur conversion JWK vers PEM:", error.message);
    throw error;
  }
};

/**
 * Extrait le token JWT depuis les headers
 */
const extractJWTToken = (headers) => {
  // Priorité 1: Header Authorization Bearer
  const authHeader = headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Priorité 2: Header personnalisé
  return headers['x-jwt-token'];
};

const validateJWT = async (req, res, next) => {
  console.log(' [JWT Middleware] Début validation JWT');
  console.log(' [JWT Middleware] Headers reçus:', {
    authorization: req.headers.authorization,
    'content-type': req.headers['content-type'],
    origin: req.headers.origin,
    referer: req.headers.referer
  });
  
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log(' [JWT Middleware] Token manquant ou format incorrect');
      console.log(' [JWT Middleware] authHeader:', authHeader);
      return res.status(401).json({ 
        error: 'Token manquant', 
        message: 'Vous devez être connecté pour effectuer cette action' 
      });
    };

    const token = authHeader.slice(7);
    console.log('🔍 [JWT Middleware] Token extrait:', token.substring(0, 50) + '...');
    
    const decodedHeader = jwt.decode(token, { complete: true });
    console.log('🔍 [JWT Middleware] Header JWT décodé:', decodedHeader?.header);
    
    if (!decodedHeader?.header?.kid) {
      console.log('❌ [JWT Middleware] JWT sans kid dans le header');
      return res.status(401).json({ 
        error: 'Token invalide', 
        message: 'Vous devez être connecté pour effectuer cette action' 
      });
    }

    const jwks = await getJWKS();
    console.log('🔍 [JWT Middleware] JWKS récupérées:', jwks ? `${jwks.keys.length} clés` : 'null');
    
    if (!jwks) {
      console.log('❌ [JWT Middleware] Impossible de récupérer les clés JWKS');
      return res.status(500).json({ 
        error: 'Erreur serveur', 
        message: 'Erreur lors de la récupération des clés JWKS' 
      });
    }

    const key = jwks.keys.find(k => k.kid === decodedHeader.header.kid);
    console.log('🔍 [JWT Middleware] Recherche clé pour kid:', decodedHeader.header.kid);
    console.log('🔍 [JWT Middleware] Clés disponibles:', jwks.keys.map(k => k.kid));
    
    if (!key) {
      console.log(`❌ [JWT Middleware] Clé JWKS non trouvée pour kid: ${decodedHeader.header.kid}`);
      return res.status(401).json({ 
        error: 'Token invalide', 
        message: 'Vous devez être connecté pour effectuer cette action' 
      });
    }

    const publicKey = await jwkToPem(key);
    
    console.log('🔍 [JWT Middleware] Tentative de vérification JWT avec clé publique');
    
    jwt.verify(token, publicKey, {
      algorithms: ['EdDSA'], // Better Auth utilise Ed25519
      issuer: process.env.FRONTEND_URL || 'http://localhost:3000',
    }, (err, decoded) => {
      if (err) {
        console.log('❌ [JWT Middleware] Erreur validation JWT:', err.message);
        console.log('❌ [JWT Middleware] Type erreur:', err.name);
        return res.status(401).json({ 
          error: 'Token invalide', 
          message: 'Vous devez être connecté pour effectuer cette action' 
        });
      }

      console.log('✅ [JWT Middleware] JWT validé avec succès');
      console.log('🔍 [JWT Middleware] Payload décodé:', decoded);
      
      const user = decoded.sub;
      req.user = user;
      console.log('✅ [JWT Middleware] Utilisateur défini dans req.user:', user);
      next();
    });
  } catch (error) {
    console.log(' [JWT Middleware] Erreur validation JWT:', error.message);
    return res.status(500).json({ 
      error: 'Erreur serveur', 
      message: 'Erreur lors de la validation du token' 
    });
  }
};

/**
 * Wrapper pour les resolvers nécessitant une authentification
 */
const isAuthenticated = (resolver) => {
  return (parent, args, context, info) => {
    console.log('🔍 [isAuthenticated] Vérification authentification');
    console.log('🔍 [isAuthenticated] context.user:', context.user);
    
    if (!context.user) {
      console.log('❌ [isAuthenticated] Utilisateur non authentifié');
      throw new AppError(
        "Vous devez être connecté pour effectuer cette action",
        ERROR_CODES.UNAUTHENTICATED
      );
    }
    return resolver(parent, args, context, info);
  };
};

/**
 * Wrapper pour les resolvers nécessitant une authentification et un workspace
 */
const withWorkspace = (resolver) => {
  return async (parent, args, context, info) => {
    console.log('🔍 [withWorkspace] Vérification authentification et workspace');
    console.log('🔍 [withWorkspace] context.user:', context.user);
    
    if (!context.user) {
      console.log('❌ [withWorkspace] Utilisateur non authentifié');
      throw new AppError(
        "Vous devez être connecté pour effectuer cette action",
        ERROR_CODES.UNAUTHENTICATED
      );
    }

    let workspaceId = args.workspaceId || context.req?.headers["x-workspace-id"];

    if (!workspaceId) {
      throw new AppError("WorkspaceId requis", ERROR_CODES.VALIDATION_ERROR);
    }

    const enhancedContext = {
      ...context,
      workspaceId,
    };

    return resolver(parent, args, enhancedContext, info);
  };
};

export { 
  betterAuthJWTMiddleware,
  validateJWT,
  isAuthenticated,
  withWorkspace
};
