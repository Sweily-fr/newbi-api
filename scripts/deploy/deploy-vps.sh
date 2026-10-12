#!/usr/bin/env bash
# Déploiement sans coupure de l'API sur le VPS :
#   bash deploy-vps.sh production|staging
#
# Appelé par .github/workflows/deploy_*.yml une fois la nouvelle version
# copiée dans <dossier de l'app>/.deploy/next. La version en ligne n'est
# touchée qu'après un démarrage d'essai réussi de la nouvelle :
#   1. dépendances réutilisées si package-lock.json n'a pas changé, sinon
#      installées à part (la version en ligne garde les siennes jusque-là) ;
#   2. démarrage d'essai sur un port de test, sans crons (canary.cjs). En cas
#      d'échec, arrêt ici, workflow en rouge, la version en ligne n'a pas bougé ;
#   3. mise en place des fichiers puis `pm2 reload` : les instances sont
#      remplacées une par une, l'ancienne ne s'arrête qu'une fois la nouvelle
#      prête (wait_ready) et après avoir fini ses requêtes ;
#   4. vérification : toutes les instances en ligne et l'API répond.

TARGET="${1:-}"
case "$TARGET" in
  production)
    APP_DIR="$HOME/api.newbi.fr"
    PM2_APP="newbi"
    ECOSYSTEM="ecosystem.production.cjs"
    ENV_FILE=".env.production"
    LIVE_PORT=4000
    CANARY_PORT=4099
    ;;
  staging)
    APP_DIR="$HOME/staging"
    PM2_APP="newbi-staging"
    # Config propre au VPS (valeurs d'env dans son bloc env), jamais écrasée
    ECOSYSTEM="ecosystem.config.cjs"
    ENV_FILE=".env.staging"
    LIVE_PORT=4001
    CANARY_PORT=4098
    ;;
  *)
    echo "Usage : deploy-vps.sh production|staging" >&2
    exit 1
    ;;
esac

NEXT="$APP_DIR/.deploy/next"
# Production : la config PM2 arrive avec la nouvelle version ; staging : celle du VPS
if [ "$TARGET" = production ]; then
  CANARY_ECOSYSTEM="$NEXT/$ECOSYSTEM"
else
  CANARY_ECOSYSTEM="$APP_DIR/$ECOSYSTEM"
fi

source "$HOME/.nvm/nvm.sh"
set -eo pipefail
PHASE="préparation, la version en ligne n'a pas changé"
trap 'echo "❌ Déploiement interrompu ($PHASE)" >&2' ERR

cd "$APP_DIR"
if [ ! -f "$NEXT/package.json" ]; then
  echo "❌ Nouvelle version absente de $NEXT" >&2
  exit 1
fi

if /snap/bin/redis.cli ping > /dev/null 2>&1; then
  echo "✅ Redis opérationnel"
else
  echo "⚠️ Redis ne répond pas : l'API passera sur son repli en mémoire"
fi

# 1. Dépendances
LOCK_HASH="$(sha256sum "$NEXT/package-lock.json" | cut -d' ' -f1)"
rm -rf "$NEXT/node_modules"
if [ "$(cat node_modules/.deploy-lock-hash 2> /dev/null)" = "$LOCK_HASH" ]; then
  echo "📦 Dépendances inchangées, celles en ligne sont réutilisées"
  ln -s ../../node_modules "$NEXT/node_modules"
  NEW_DEPS=false
else
  echo "📦 package-lock.json a changé : installation à part des dépendances..."
  (cd "$NEXT" && HUSKY=0 npm ci --no-audit --no-fund)
  echo "$LOCK_HASH" > "$NEXT/node_modules/.deploy-lock-hash"
  NEW_DEPS=true
fi

# 2. Démarrage d'essai
echo "🧪 Démarrage d'essai de la nouvelle version (port $CANARY_PORT, sans crons)..."
ln -sfn "$APP_DIR/$ENV_FILE" "$NEXT/$ENV_FILE"
node "$NEXT/scripts/deploy/canary.cjs" --cwd "$NEXT" \
  --ecosystem "$CANARY_ECOSYSTEM" --app "$PM2_APP" --port "$CANARY_PORT"

# 3. Mise en place puis remplacement des instances
PHASE="mise en place de la nouvelle version"
echo "📂 Mise en place des fichiers..."
EXCLUDES=(--exclude=node_modules --exclude=.env --exclude='.env.*'
  --exclude=logs --exclude=log --exclude=uploads --exclude=temp
  --exclude=.cache --exclude=ecosystem.config.cjs)
if [ "$TARGET" = staging ]; then
  EXCLUDES+=(--exclude=ecosystem.production.cjs)
fi
rsync -a "${EXCLUDES[@]}" "$NEXT/" "$APP_DIR/"

if [ "$TARGET" = production ] &&
  ! grep -q "ecosystem.production.cjs" ecosystem.config.cjs 2> /dev/null; then
  if [ -f ecosystem.config.cjs ]; then
    cp ecosystem.config.cjs "ecosystem.config.cjs.bak-$(date +%Y%m%d-%H%M%S)"
  fi
  cat > ecosystem.config.cjs << 'EOF'
// La configuration PM2 de la production est versionnée dans le dépôt de
// l'API (ecosystem.production.cjs), mise à jour à chaque déploiement.
module.exports = require("./ecosystem.production.cjs");
EOF
  echo "   ecosystem.config.cjs renvoie vers ecosystem.production.cjs (ancien fichier sauvegardé)"
fi

if [ "$NEW_DEPS" = true ]; then
  rm -rf .deploy/previous-node_modules
  if [ -d node_modules ]; then
    mv node_modules .deploy/previous-node_modules
  fi
  mv "$NEXT/node_modules" node_modules
fi

PHASE="redémarrage de l'API"
if pm2 jlist | node scripts/deploy/pm2-app.cjs supports-reload "$PM2_APP"; then
  echo "🔄 Remplacement des instances une par une, sans coupure..."
  PM2_CONCURRENT_ACTIONS=1 pm2 reload "$ECOSYSTEM" --only "$PM2_APP"
else
  echo "🔁 Bascule vers le redémarrage sans coupure : arrêt complet unique (~30 s)"
  pm2 delete "$PM2_APP" || true
  pm2 start "$ECOSYSTEM" --only "$PM2_APP"
fi
pm2 save

# 4. Vérification
PHASE="vérification après redémarrage"
echo "✅ Vérification..."
for attempt in $(seq 1 60); do
  if curl -sf -o /dev/null -m 5 "http://127.0.0.1:$LIVE_PORT/graphql?query=%7B__typename%7D"; then
    break
  fi
  if [ "$attempt" = 60 ]; then
    echo "❌ L'API ne répond pas sur le port $LIVE_PORT" >&2
    exit 1
  fi
  sleep 2
done
echo "   API joignable sur le port $LIVE_PORT"
pm2 jlist | node scripts/deploy/pm2-app.cjs all-online "$PM2_APP" "$ECOSYSTEM"

rm -rf .deploy/previous-node_modules
pm2 status "$PM2_APP"
echo "🎉 Déploiement $TARGET terminé"
