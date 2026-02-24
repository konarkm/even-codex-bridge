#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8788}"
APP_HOST="${APP_HOST:-codex-even-app.example.com}"
API_HOST="${API_HOST:-codex-even-api.example.com}"
APP_SERVICE="${APP_SERVICE:-http://127.0.0.1:5173}"
API_SERVICE="${API_SERVICE:-http://127.0.0.1:${PORT}}"
PROVISION_DNS=0
TMP_CONFIG=""
TOKEN_FILE=""
TOKEN_ERR_FILE=""

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

AUTH_MODE="credentials-file"
CREDENTIALS_FILE="${HOME}/.cloudflared/${TUNNEL_ID}.json"
if [[ ! -f "${CREDENTIALS_FILE}" ]]; then
  AUTH_MODE="token-file"
  TOKEN_FILE="$(mktemp -t codex-even-token.XXXXXX)"
  chmod 600 "${TOKEN_FILE}"

  if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
    printf '%s\n' "${TUNNEL_TOKEN}" > "${TOKEN_FILE}"
  else
    TOKEN_ERR_FILE="$(mktemp -t codex-even-token-err.XXXXXX)"
    if ! cloudflared tunnel token "${TUNNEL_NAME}" > "${TOKEN_FILE}" 2>"${TOKEN_ERR_FILE}"; then
      echo "Missing credentials file at ${CREDENTIALS_FILE}"
      echo "Also failed to obtain a runtime token for tunnel '${TUNNEL_NAME}'."
      echo "Fix one of the following:"
      echo "  1) Authenticate cloudflared and retry"
      echo "  2) Export TUNNEL_TOKEN"
      echo "  3) Place ${CREDENTIALS_FILE}"
      if [[ -s "${TOKEN_ERR_FILE}" ]]; then
        echo
        echo "cloudflared token error:"
        cat "${TOKEN_ERR_FILE}"
      fi
      exit 1
    fi
  fi
fi

if [[ "${PROVISION_DNS}" -eq 1 ]]; then
  echo "Provisioning DNS routes for ${TUNNEL_NAME}"
  cloudflared tunnel route dns "${TUNNEL_ID}" "${APP_HOST}"
  cloudflared tunnel route dns "${TUNNEL_ID}" "${API_HOST}"
fi

cleanup() {
  if [[ -n "${TMP_CONFIG}" ]]; then
    rm -f "${TMP_CONFIG}"
  fi
  if [[ -n "${TOKEN_FILE}" ]]; then
    rm -f "${TOKEN_FILE}"
  fi
  if [[ -n "${TOKEN_ERR_FILE}" ]]; then
    rm -f "${TOKEN_ERR_FILE}"
  fi
}
trap cleanup EXIT
TMP_CONFIG="$(mktemp -t codex-even-tunnel.XXXXXX.yml)"

{
  echo "tunnel: ${TUNNEL_ID}"
  if [[ "${AUTH_MODE}" == "credentials-file" ]]; then
    echo "credentials-file: ${CREDENTIALS_FILE}"
  fi
  cat <<EOF
ingress:
  - hostname: ${APP_HOST}
    service: ${APP_SERVICE}
  - hostname: ${API_HOST}
    service: ${API_SERVICE}
  - service: http_status:404
EOF
} > "${TMP_CONFIG}"

echo "Starting tunnel '${TUNNEL_NAME}' (${TUNNEL_ID})"
echo "  ${APP_HOST} -> ${APP_SERVICE}"
echo "  ${API_HOST} -> ${API_SERVICE}"
if [[ "${AUTH_MODE}" == "credentials-file" ]]; then
  exec cloudflared --config "${TMP_CONFIG}" tunnel run "${TUNNEL_ID}"
fi
exec cloudflared --config "${TMP_CONFIG}" tunnel run --token-file "${TOKEN_FILE}" "${TUNNEL_ID}"
