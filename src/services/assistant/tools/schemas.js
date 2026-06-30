/**
 * Définitions des tools envoyées au LLM (claude-haiku-4-5).
 *
 * RÈGLES (issues du plan validé) :
 *  - Read-only strict. Aucun tool de mutation.
 *  - Le LLM ne calcule rien : les handlers retournent les chiffres déjà
 *    calculés ET pré-interprétés (deltaPct + direction "hausse/baisse/stable").
 *  - Sur les périodes : enum strict sur 6 valeurs. Si l'utilisateur demande
 *    une période hors enum (mois non récent, plage glissante "depuis X",
 *    "ces N derniers mois"…), NE PAS appeler le tool. Répondre poliment que
 *    la période n'est pas couverte et proposer this_month / last_month /
 *    this_year.
 *  - `deltaPct` du retour peut être `null` (pas de période comparable). Dans
 *    ce cas : NE PAS mentionner d'évolution, ne pas inventer "+0%" ni dire
 *    "stable".
 *  - Sur `category` : si rien ne matche clairement, OMETTRE le paramètre
 *    plutôt que de choisir OTHER par défaut.
 */

export const TOOL_SCHEMAS = [
  {
    name: "get_revenue",
    description: `Récupère le chiffre d'affaires HT sur une période préfaite, avec la comparaison à la période équivalente précédente (mois N-1 pour this_month, année N-1 pour this_year, etc.).

À UTILISER pour : "CA", "chiffre d'affaires", "ventes", "recettes", "combien j'ai facturé".

NE PAS UTILISER pour :
- les dépenses (utiliser get_expenses) ni la trésorerie (utiliser get_treasury_evolution) ;
- les plages glissantes type "depuis janvier", "ces 3 derniers mois", "sur les 6 derniers mois", "depuis X jours/semaines" — non couvert. Réponds que cette fenêtre n'est pas supportée en V1 et propose this_month, last_month ou this_year ;
- un mois spécifique non récent (ex. "mars" quand on est en juin) — non couvert. Propose last_month si l'utilisateur veut le mois précédent.

Le retour contient deltaPct (variation % vs période précédente) qui peut être null. Si null, NE PAS mentionner d'évolution ni inventer une valeur. Si non null, utilise le champ direction ("hausse" | "baisse" | "stable") déjà déterminé.`,
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: [
            "this_month",
            "last_month",
            "this_quarter",
            "last_quarter",
            "this_year",
            "last_year",
          ],
          description: `Période préfaite. La date courante est passée en début du message utilisateur ("[Date courante : YYYY-MM-DD]"), utilise-la pour résoudre les années/mois cités. Mapping :
- "this_month" : "ce mois", "ce mois-ci", "le mois en cours", OU un mois cité explicitement égal au mois courant.
- "last_month" : "le mois dernier", OU un mois cité explicitement qui correspond au mois immédiatement précédent (ex. "mai" si la date courante est en juin).
- "this_quarter" : "ce trimestre", "le trimestre en cours".
- "last_quarter" : "le trimestre dernier", OU le trimestre immédiatement précédent (ex. "T1" si la date courante est en T2).
- "this_year" : "cette année", "l'année en cours", OU une année citée explicitement égale à l'année courante (ex. "2026" si la date courante est en 2026).
- "last_year" : "l'année dernière", OU une année citée explicitement qui correspond à l'année précédente (ex. "2025" si la date courante est en 2026). EXEMPLE CRITIQUE : "CA 2025" en 2026 → APPELLE last_year DIRECTEMENT, NE pose PAS de question de confirmation.

HORS PÉRIMÈTRE (n'appelle PAS le tool) :
- Année citée qui n'est ni l'actuelle ni la précédente (ex. "2024" en 2026, "2022", etc.).
- Mois cité qui n'est ni l'actuel ni le précédent (ex. "mars" en juin).
- Plage glissante : "ces N derniers mois", "depuis janvier", "sur les 6 derniers mois", "depuis X jours/semaines".`,
        },
      },
      required: ["period"],
    },
  },

  {
    name: "list_overdue_invoices",
    description: `Liste les factures dont la date d'échéance est dépassée et qui ne sont PAS encore réglées, avec leur montant et leur retard en jours, plus un résumé (total + nombre).

À UTILISER pour : "mes impayés", "factures en retard", "qui me doit de l'argent", "créances échues", "qui n'a pas payé".

NE PAS UTILISER pour les factures émises non encore échues (= en attente de paiement avant l'échéance) — ce cas n'est pas couvert par un tool dédié en V1. Réponds que tu peux montrer les retards mais pas les factures en attente.

Les noms de clients dans le retour sont sous forme "Client_N" (anonymisés) — utilise-les tels quels dans ta réponse.`,
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description:
            "Nombre maximum de factures à retourner. Garder bas par défaut (5–10) sauf si l'utilisateur demande explicitement une liste complète. Si non précisé, vise 10.",
        },
      },
    },
  },

  {
    name: "get_top_clients",
    description: `Classement des clients par chiffre d'affaires sur une période, avec leur part en pourcentage et leur nombre de factures.

À UTILISER pour : "mes meilleurs clients", "top clients", "qui me rapporte le plus", "classement clients".

NE PAS UTILISER pour interroger un client précis par son nom (pas couvert en V1) — réponds que tu ne peux que classer, pas isoler un client précis.

Comme pour list_overdue_invoices, les noms de clients sont sous forme "Client_N" (anonymisés).`,
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: [
            "this_month",
            "last_month",
            "this_quarter",
            "last_quarter",
            "this_year",
            "last_year",
          ],
          description:
            "Période d'analyse. Mêmes règles que get_revenue.period : utiliser la date courante injectée dans le message user pour résoudre années/mois cités ; appel direct si couvert, refus si hors périmètre (année autre que actuelle/précédente, mois autre que actuel/précédent, plage glissante).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description:
            "Nombre de clients à classer. Défaut 5, max 20. Si non précisé, prends 5.",
        },
      },
      required: ["period"],
    },
  },

  {
    name: "get_treasury_evolution",
    description: `Évolution du solde de trésorerie sur les N derniers mois (fenêtre roulante, PAS calendaire), avec la série mensuelle, le solde courant, et la variation depuis le début de la fenêtre.

À UTILISER pour : "ma trésorerie", "mon solde", "évolution cash", "comment évolue mon argent".

NE PAS UTILISER pour les recettes seules (get_revenue) ni les dépenses seules (get_expenses).

Le retour contient deltaPct (variation % depuis le début de la fenêtre). Si null, NE PAS mentionner d'évolution. Si non null, utilise le champ direction ("hausse" | "baisse" | "stable").`,
    input_schema: {
      type: "object",
      properties: {
        months: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description:
            "Fenêtre roulante en mois (PAS une période calendaire — c'est N mois en arrière depuis aujourd'hui). Valeurs courantes : 3, 6, 12. Défaut 6 si non précisé.",
        },
      },
    },
  },

  {
    name: "get_expenses",
    description: `Total des dépenses sur une période, avec ventilation par catégorie. Possibilité de filtrer sur une catégorie unique.

À UTILISER pour : "mes dépenses", "combien j'ai dépensé", "dépenses de X" (X = une catégorie).

NE PAS UTILISER pour les factures fournisseurs spécifiques (pas couvert en V1).

Pour le filtre category : si rien ne matche clairement, OMETTRE le paramètre plutôt que choisir OTHER par défaut. Désambiguïsations critiques : "abonnement logiciel/SaaS/outil" → SOFTWARE ; "abonnement (téléphone, presse, autre)" → SUBSCRIPTIONS ; "prestation/freelance/sous-traitance" → SERVICES ; "entretien/réparation matériel" → MAINTENANCE.`,
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: [
            "this_month",
            "last_month",
            "this_quarter",
            "last_quarter",
            "this_year",
            "last_year",
          ],
          description:
            "Période d'analyse. Mêmes règles que get_revenue.period : utiliser la date courante injectée dans le message user pour résoudre années/mois cités ; appel direct si couvert, refus si hors périmètre.",
        },
        category: {
          type: "string",
          enum: [
            "OFFICE_SUPPLIES",
            "TRAVEL",
            "MEALS",
            "ACCOMMODATION",
            "SOFTWARE",
            "HARDWARE",
            "SERVICES",
            "MARKETING",
            "TAXES",
            "RENT",
            "UTILITIES",
            "SALARIES",
            "INSURANCE",
            "MAINTENANCE",
            "TRAINING",
            "SUBSCRIPTIONS",
            "OTHER",
          ],
          description:
            "Filtre optionnel sur une catégorie. Le sens des valeurs est explicite (MEALS = repas/restaurants, RENT = loyer, etc.). Si l'utilisateur ne précise PAS de catégorie, OMETTRE ce paramètre. Si le terme employé ne matche pas clairement une catégorie, OMETTRE plutôt que choisir OTHER par défaut.",
        },
      },
      required: ["period"],
    },
  },
];
