#!/bin/sh
# Substitute the build-time API-URL placeholder with the real server URL.
# Runs (via nginx:alpine's /docker-entrypoint.d/ hook) before nginx starts.
set -e
: "${WASP_SERVER_URL:?WASP_SERVER_URL must be set on the web-client service}"
echo "[web-client] baking API URL → ${WASP_SERVER_URL}"
find /usr/share/nginx/html -type f \( -name '*.js' -o -name '*.html' \) \
  -exec sed -i "s|__ALFRED_API_URL__|${WASP_SERVER_URL}|g" {} +
echo "[web-client] API URL substitution complete"
