import mongoose from "mongoose";
import addressSchema from "./address.js";
import { isPositiveAmount } from "../../utils/validators.js";

/**
 * Schéma de livraison pour les factures et devis
 */
const shippingSchema = new mongoose.Schema({
  // Indique si la livraison doit être facturée
  billShipping: {
    type: Boolean,
    default: false,
  },
  // Adresse de livraison (utilise le schéma d'adresse existant)
  // Note — l'option `required: function() { return this.billShipping; }`
  // ne se déclenche pas sur les sous-documents typés `addressSchema`
  // quand la valeur est absente (undefined) : Mongoose skip la validation
  // required. On utilise un pre-validate hook au niveau du schéma shipping
  // pour vérifier explicitement que les champs critiques sont fournis
  // quand billShipping=true.
  shippingAddress: {
    type: addressSchema,
  },
  // Montant HT de la livraison
  shippingAmountHT: {
    type: Number,
    min: 0,
    default: 0,
    required: function () {
      return this.billShipping;
    },
    validate: {
      validator: function (value) {
        if (!this.billShipping) return true;
        return isPositiveAmount(value);
      },
      message: "Le montant HT de la livraison doit être un nombre positif",
    },
  },
  // Taux de TVA pour la livraison
  shippingVatRate: {
    type: Number,
    min: 0,
    max: 100,
    default: 20,
    required: function () {
      return this.billShipping;
    },
    validate: {
      validator: function (value) {
        if (!this.billShipping) return true;
        return value >= 0 && value <= 100;
      },
      message: "Le taux de TVA doit être compris entre 0 et 100",
    },
  },
});

// Hook pre-validate : quand billShipping=true, exige une shippingAddress
// dont au moins `street`, `city` et `postalCode` sont renseignés. Le
// validator `required` au niveau du champ ne se déclenche pas pour les
// subdocs typés quand la valeur est absente — d'où ce hook au niveau du
// schéma shipping. Idempotent pour les invoices existantes avec
// billShipping=false (skip).
shippingSchema.pre("validate", function (next) {
  if (!this.billShipping) {
    return next();
  }
  const addr = this.shippingAddress;
  const missing = [];
  if (!addr) {
    missing.push("street", "city", "postalCode");
  } else {
    if (!addr.street || !addr.street.trim()) missing.push("street");
    if (!addr.city || !addr.city.trim()) missing.push("city");
    if (!addr.postalCode || !addr.postalCode.trim()) missing.push("postalCode");
  }
  if (missing.length > 0) {
    // `this.invalidate(...)` flag the path as invalid : Mongoose collects
    // ces erreurs et les remonte au parent (Invoice.save) sous forme de
    // ValidationError standard. Plus fiable que next(err) pour les hooks
    // de sous-documents.
    this.invalidate(
      "shippingAddress",
      `L'adresse de livraison est requise quand billShipping=true (champs manquants : ${missing.join(", ")})`,
    );
  }
  next();
});

export default shippingSchema;
