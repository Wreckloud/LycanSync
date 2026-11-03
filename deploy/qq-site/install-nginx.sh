#!/bin/sh
set -eu
if [ "$(id -u)" != 0 ]; then
    echo '请使用 sudo sh install-nginx.sh 执行。' >&2
    exit 1
fi
domain=lycansync.wreckloud.com
site=/etc/nginx/sites-available/lycansync-qq
enabled=/etc/nginx/sites-enabled/lycansync-qq
cert=/etc/letsencrypt/live/lycansync.wreckloud.com
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p /var/www/lycansync-acme/.well-known/acme-challenge
if [ -f "$site" ]; then cp -p "$site" "$work/previous"; fi
cat > "$work/http" <<'NGINX'
server {
    listen 80;
    server_name lycansync.wreckloud.com;
    access_log off;
    error_log /var/log/nginx/lycansync-qq-error.log crit;
    location ^~ /.well-known/acme-challenge/ { root /var/www/lycansync-acme; }
    location / { return 503; }
}
NGINX
if [ ! -f "$cert/fullchain.pem" ]; then
    install -m 644 "$work/http" "$site"
    ln -sfn "$site" "$enabled"
    if ! nginx -t; then
        if [ -f "$work/previous" ]; then cp -p "$work/previous" "$site"; else rm -f "$enabled" "$site"; fi
        exit 1
    fi
    systemctl reload nginx
    certbot certonly --webroot -w /var/www/lycansync-acme -d "$domain" \
        --cert-name "$domain" --non-interactive --agree-tos
fi
cat > "$work/site" <<'NGINX'
server {
    listen 80;
    server_name lycansync.wreckloud.com;
    location ^~ /.well-known/acme-challenge/ { root /var/www/lycansync-acme; }
    location / { return 301 https://lycansync.wreckloud.com$request_uri; }
    access_log off;
    error_log /var/log/nginx/lycansync-qq-error.log crit;
}
server {
    listen 443 ssl;
    server_name lycansync.wreckloud.com;
    ssl_certificate /etc/letsencrypt/live/lycansync.wreckloud.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lycansync.wreckloud.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    # QQ 回调带短期 code/state，禁止将完整请求写入访问或普通错误日志。
    access_log off;
    error_log /var/log/nginx/lycansync-qq-error.log crit;
    client_max_body_size 6m;
    location ^~ /internal/ { return 404; }
    location ^~ /actuator/ { return 404; }
    location / {
        proxy_pass http://127.0.0.1:18081;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Lycan-Client-IP $remote_addr;
        proxy_set_header Authorization $http_authorization;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }
}
NGINX
install -m 644 "$work/site" "$site"
ln -sfn "$site" "$enabled"
if ! nginx -t; then
    if [ -f "$work/previous" ]; then cp -p "$work/previous" "$site"; else rm -f "$enabled" "$site"; fi
    exit 1
fi
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '%s\n' '#!/bin/sh' 'nginx -t && systemctl reload nginx' > /etc/letsencrypt/renewal-hooks/deploy/lycansync-nginx.sh
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/lycansync-nginx.sh
systemctl reload nginx
echo 'LycanSync 官网 HTTPS 已启用；未重启其他后端或修改其他站点。'
