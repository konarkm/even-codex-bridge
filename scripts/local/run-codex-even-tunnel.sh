#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8788}"
APP_HOST="${APP_HOST:-codex-even-app.example.com}"
API_HOST="${API_HOST:-codex-even-api.example.com}"
APP_SERVICE="${APP_SERVICE:-http://127.0.0.1:5173}"
API_SERVICE="${API_SERVICE:-http://127.0.0.1:${PORT}}"
PROVISION_DNS=0

for arg in "$@"; do
  if [[ "${arg}" == "--provision-dns" ]]; then
    PROVISION_DNS=1
  fi
done

if [[ "${1:-}" == "--quick" ]]; then
  echo "Starting quick tunnel for ${API_SERVICE}"
  exec cloudflared tunnel --url "${API_SERVICE}"
fi

if [[ -n "${1:-}" ]] && [[ "${1}" != "--provision-dns" ]]; then
  TUNNEL_NAME="${1}"
else
  TUNNEL_NAME="codex-even"
fi

TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v name="${TUNNEL_NAME}" '$2 == name { print $1; exit }')"
if [[ -z "${TUNNEL_ID}" ]]; then
  echo "Tunnel '${TUNNEL_NAME}' was not found."
  echo "Create it first:"
  echo "  cloudflared tunnel create ${TUNNEL_NAME}"
  echo "Then route DNS:"
  echo "  cloudflared tunnel route dns ${TUNNEL_NAME} ${APP_HOST}"
  echo "  cloudflared tunnel route dns ${TUNNEL_NAME} ${API_HOST}"
  exit 1
fi

CREDENTIALS_FILE="${HOME}/.cloudflared/${TUNNEL_ID}.json"
if [[ ! -f "${CREDENTIALS_FILE}" ]]; then
  echo "Missing credentials file at ${CREDENTIALS_FILE}"
  exit 1
fi

if [[ "${PROVISION_DNS}" -eq 1 ]]; then
  echo "Provisioning DNS routes for ${TUNNEL_NAME}"
  cloudflared tunnel route dns "${TUNNEL_ID}" "${APP_HOST}"
  cloudflared tunnel route dns "${TUNNEL_ID}" "${API_HOST}"
fi

TMP_CONFIG="$(mktemp -t codex-even-tunnel.XXXXXX.yml)"
cleanup() {
  rm -f "${TMP_CONFIG}"
}
trap cleanup EXIT

cat > "${TMP_CONFIG}" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CREDENTIALS_FILE}
ingress:
  - hostname: ${APP_HOST}
    service: ${APP_SERVICE}
  - hostname: ${API_HOST}
    service: ${API_SERVICE}
  - service: http_status:404
EOF

echo "Starting tunnel '${TUNNEL_NAME}' (${TUNNEL_ID})"
echo "  ${APP_HOST} -> ${APP_SERVICE}"
echo "  ${API_HOST} -> ${API_SERVICE}"
exec cloudflared --config "${TMP_CONFIG}" tunnel run "${TUNNEL_ID}"
