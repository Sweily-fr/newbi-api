import express from "express";
import superPdpService from "../services/superPdpService.js";
import redisService from "../services/redisService.js";
import logger from "../utils/logger.js";

/**
 * Route publique (sans auth) : vérifie si une entreprise est inscrite dans
 * l'annuaire de la facturation électronique (plateforme agréée).
 *
 * GET /api/public/einvoicing/directory?siren=123456789
 *  → { available: true, registered: true|false, pdpName }
 *  → { available: false } si la vérification n'est pas configurée / indisponible
 *
 * L'annuaire SuperPDP s'interroge avec les identifiants OAuth d'une
 * organisation : on utilise l'organisation « système » désignée par
 * SUPERPDP_DIRECTORY_LOOKUP_ORG_ID (ex. l'organisation Sweily). Utilisé par le
 * simulateur « Es-tu concerné ? » de la LP facturation électronique.
 */

const router = express.Router();

const RATE_LIMIT_WINDOW = 60; // secondes
const RATE_LIMIT_MAX = 20; // requêtes / IP / fenêtre
const CACHE_TTL = 60 * 60 * 6; // 6 h : une inscription à l'annuaire change rarement

const rateLimitMap = new Map();
const memoryCache = new Map();

async function checkRateLimit(ip) {
  if (redisService.isConnected && redisService.client) {
    try {
      const key = `einv-dir-rl:${ip}`;
      const count = await redisService.client.incr(key);
      if (count === 1) await redisService.client.expire(key, RATE_LIMIT_WINDOW);
      return count <= RATE_LIMIT_MAX;
    } catch (err) {
      logger.warn(
        `[EInvoicingDirectory] Erreur Redis rate limit, fallback in-memory: ${err.message}`,
      );
    }
  }
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW * 1000) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

async function getCached(siren) {
  if (redisService.isConnected && redisService.client) {
    try {
      const raw = await redisService.client.get(`einv-dir:${siren}`);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      logger.warn(`[EInvoicingDirectory] Lecture cache Redis: ${err.message}`);
    }
  }
  const entry = memoryCache.get(siren);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  return null;
}

async function setCached(siren, value) {
  if (redisService.isConnected && redisService.client) {
    try {
      await redisService.client.set(
        `einv-dir:${siren}`,
        JSON.stringify(value),
        "EX",
        CACHE_TTL,
      );
      return;
    } catch (err) {
      logger.warn(`[EInvoicingDirectory] Écriture cache Redis: ${err.message}`);
    }
  }
  memoryCache.set(siren, { value, expiresAt: Date.now() + CACHE_TTL * 1000 });
}

router.get("/directory", async (req, res) => {
  const siren = String(req.query.siren || "").replace(/\s/g, "");
  if (!/^\d{9}$/.test(siren)) {
    return res.status(400).json({ error: "SIREN invalide (9 chiffres)" });
  }

  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  if (!(await checkRateLimit(ip))) {
    return res
      .status(429)
      .json({ error: "Trop de requêtes, réessayez dans une minute." });
  }

  const lookupOrgId = process.env.SUPERPDP_DIRECTORY_LOOKUP_ORG_ID;
  if (!lookupOrgId) {
    return res.json({ available: false });
  }

  try {
    const cached = await getCached(siren);
    if (cached) return res.json(cached);

    const result = await superPdpService.checkRecipientDirectory(
      lookupOrgId,
      siren,
    );
    if (!result.success) {
      logger.warn(
        `[EInvoicingDirectory] Annuaire indisponible pour ${siren}: ${result.error}`,
      );
      return res.json({ available: false });
    }

    const payload = {
      available: true,
      registered: Boolean(result.canReceiveEInvoices),
      pdpName: result.pdpName || null,
    };
    await setCached(siren, payload);
    return res.json(payload);
  } catch (error) {
    logger.error(`[EInvoicingDirectory] Erreur pour ${siren}:`, error);
    return res.json({ available: false });
  }
});

export default router;
