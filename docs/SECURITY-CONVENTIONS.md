# Security Conventions

Conventions de sécurité pour le backend newbi-api.

## Multi-tenant data access

Tout query Mongoose sur un model avec un champ `workspaceId` DOIT inclure
le filtre `workspaceId`, même si la query est protégée en amont par un
wrapper RBAC.

### Patterns autorisés

```javascript
Model.findOne({ _id, workspaceId });
Model.findOneAndUpdate({ _id, workspaceId }, update);
Model.findOneAndDelete({ _id, workspaceId });
Model.find({ workspaceId, ...filters });
Model.deleteMany({ _id: { $in: ids }, workspaceId });
Model.updateMany({ workspaceId, ...filters }, update);
```

### Patterns interdits

```javascript
Model.findById(id); // pas de filtre workspaceId
Model.deleteOne({ _id: id }); // idem
Model.findByIdAndUpdate(id); // idem
Model.findByIdAndDelete(id); // idem
```

### Exception

Les queries sur des models SANS champ `workspaceId` peuvent utiliser
findById :

- `User`
- `Subscription`
- `Session`
- `BetterAuth*` collections

### Pourquoi cette convention

Même quand un wrapper RBAC vérifie la membership en amont, le filtre
workspaceId dans la query Mongoose est une défense en profondeur :

1. Si le wrapper a un bug ou est bypass, le filtre Mongoose protège.
2. Si un nouveau resolver est créé sans wrapper, le pattern visible
   dans le fichier guide vers la sécurité.
3. Si un caller interne (service, cron) appelle la fonction sans
   contexte d'auth, le filtre force l'explicitation du workspaceId.

## Wrappers de sécurité

### withRBAC (recommandé pour les resolvers métier)

Permission fine read/write/delete + vérification de membership.

```javascript
import {
  requireRead,
  requireWrite,
  requireDelete,
} from "../middlewares/rbac.js";

myResolver: requireRead("resourceName")(async (_, { id }, context) => {
  // context.workspaceId est garanti vérifié
});
```

### withWorkspace (depuis Sprint 11-CRITICAL)

Vérifie la membership comme withRBAC mais sans permission fine.
À utiliser si pas besoin de différencier read/write/delete.

```javascript
import { withWorkspace } from "../middlewares/better-auth-jwt.js";

myResolver: withWorkspace(async (_, args, context) => {
  // context.workspaceId est garanti vérifié
});
```

### isAuthenticated (à éviter pour les resolvers multi-tenant)

Vérifie uniquement l'authentification, pas la membership.
À utiliser uniquement pour des resolvers non-multi-tenant.

## Resolution du workspaceId

Quand le schema GraphQL accepte `workspaceId` en args, utiliser
`resolveWorkspaceId` pour réconcilier args et context :

```javascript
import { resolveWorkspaceId } from "../middlewares/rbac.js";

myResolver: requireRead("resource")(
  async (_, { workspaceId: inputWorkspaceId, ...rest }, context) => {
    const workspaceId = resolveWorkspaceId(
      inputWorkspaceId,
      context.workspaceId,
    );
  },
);
```

## Mongoose queries

### À éviter

- `Math.random()` pour des IDs ou tokens
- `Math.random().toString(36)` pour de l'identification

### Recommandé

```javascript
import crypto from "crypto";

const opaqueId = crypto.randomBytes(16).toString("hex");
const shortToken = crypto.randomBytes(8).toString("hex");
```

## Mises à jour

Cette convention évolue. Les changements sont documentés dans le commit log
et référencés dans `SECURITY-AUDIT-TRACKING.md`.
