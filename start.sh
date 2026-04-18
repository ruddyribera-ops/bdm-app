#!/bin/sh
node server.js &
sleep 2
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
