.PHONY: deploy deploy-staging

deploy:
	rsync -avz --exclude='uploads' --exclude='node_modules' -e 'ssh -i ~/.ssh/vps_key' ./* joaquim@51.91.254.74:~/api.newbi.fr
	ssh -i ~/.ssh/vps_key joaquim@51.91.254.74 'source ~/.nvm/nvm.sh && cd api.newbi.fr && \
		echo "🔄 Vérification Redis..." && \
		if redis.cli -a "7dkY6dNWbGVLGpQqAOeEEi" ping > /dev/null 2>&1; then \
			echo "✅ Redis opérationnel"; \
		else \
			echo "❌ Redis problème - redémarrage..."; \
			sudo snap restart redis; \
			sleep 3; \
			if redis.cli -a "7dkY6dNWbGVLGpQqAOeEEi" ping > /dev/null 2>&1; then \
				echo "✅ Redis redémarré avec succès"; \
			else \
				echo "⚠️ Redis indisponible - l'\''app utilisera le fallback mémoire"; \
			fi; \
		fi && \
		npm ci --omit=dev && npm install && pm2 reload newbi && \
		echo "🎉 Déploiement terminé avec Redis PubSub"'

deploy-staging:
	rsync -avz --exclude='uploads' --exclude='node_modules' -e 'ssh -i ~/.ssh/vps_key' ./* joaquim@51.91.254.74:~/staging
	ssh -i ~/.ssh/vps_key joaquim@51.91.254.74 'source ~/.nvm/nvm.sh && cd staging && \
		echo "🔄 Vérification Redis..." && \
		if redis.cli -a "7dkY6dNWbGVLGpQqAOeEEi" ping > /dev/null 2>&1; then \
			echo "✅ Redis opérationnel"; \
		else \
			echo "❌ Redis problème - redémarrage..."; \
			sudo snap restart redis; \
			sleep 3; \
			if redis.cli -a "7dkY6dNWbGVLGpQqAOeEEi" ping > /dev/null 2>&1; then \
				echo "✅ Redis redémarré avec succès"; \
			else \
				echo "⚠️ Redis indisponible - l'\''app utilisera le fallback mémoire"; \
			fi; \
		fi && \
		npm ci --omit=dev && npm install && pm2 reload newbi-staging && \
		echo "🎉 Déploiement STAGING terminé avec Redis PubSub"'