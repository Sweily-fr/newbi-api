.PHONY: deploy
deploy:
	rsync -avz --exclude='uploads' --exclude='node_modules' -e 'ssh -i ~/.ssh/vps_key' ./* joaquim@51.91.254.74:~/api.newbi.fr
	ssh -i ~/.ssh/vps_key joaquim@51.91.254.74 'source ~/.nvm/nvm.sh && cd api.newbi.fr && npm ci --omit=dev && npm install && pm2 reload newbi'