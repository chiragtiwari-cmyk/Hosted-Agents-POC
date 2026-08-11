#!/usr/bin/env bash
#
# Build, push, and deploy the agent to Microsoft Foundry as a hosted agent.
#
# Prerequisites — deployment fails without both of these:
#   1. You need Foundry Project Manager at project scope (to create agent versions).
#   2. The agent identity needs AcrPull (or Container Registry Repository Reader)
#      on the registry, or Foundry cannot pull the image.
#
# Usage:
#   export ACR_NAME=myregistry
#   export FOUNDRY_PROJECT_ENDPOINT=https://<account>.services.ai.azure.com/api/projects/<project>
#   export OPENAI_API_KEY=sk-...            # if using the OpenAI provider
#   ./scripts/deploy.sh [tag]
#
set -euo pipefail

TAG="${1:-v$(date +%Y%m%d-%H%M%S)}"
IMAGE_NAME="${IMAGE_NAME:-foundry-orchestration-lab}"
AGENT_NAME="${AGENT_NAME:-banking-supervisor}"
CPU="${CPU:-1}"
MEMORY="${MEMORY:-2Gi}"

: "${ACR_NAME:?set ACR_NAME to your Azure Container Registry name}"
: "${FOUNDRY_PROJECT_ENDPOINT:?set FOUNDRY_PROJECT_ENDPOINT to your project endpoint}"

REGISTRY="${ACR_NAME}.azurecr.io"
IMAGE="${REGISTRY}/${IMAGE_NAME}:${TAG}"

echo "==> Tests and typecheck"
npm test
npm run typecheck

# linux/amd64 is mandatory. ARM images deploy and then fail to start.
echo "==> Building ${IMAGE} (linux/amd64)"
docker build --platform linux/amd64 -t "${IMAGE}" .

echo "==> Pushing to ${REGISTRY}"
az acr login --name "${ACR_NAME}"
docker push "${IMAGE}"

echo "==> Creating agent version"
TOKEN="$(az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv)"

# Environment passed to the running container. Only include a provider secret if
# one is set locally; prefer a Foundry project connection for real deployments.
ENV_JSON="{}"
if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  ENV_JSON="$(printf '{"OPENAI_API_KEY":"%s","OPENAI_MODEL":"%s"}' \
    "${OPENAI_API_KEY}" "${OPENAI_MODEL:-gpt-4o-mini}")"
  echo "    provider: OpenAI API (${OPENAI_MODEL:-gpt-4o-mini})"
else
  ENV_JSON="$(printf '{"MODEL_DEPLOYMENT_NAME":"%s"}' "${MODEL_DEPLOYMENT_NAME:-gpt-4.1-mini}")"
  echo "    provider: Azure/Foundry model via managed identity"
fi

BODY="$(cat <<JSON
{
  "name": "${AGENT_NAME}",
  "definition": {
    "kind": "hosted",
    "container_configuration": { "image": "${IMAGE}" },
    "cpu": "${CPU}",
    "memory": "${MEMORY}",
    "protocol_versions": [
      { "protocol": "responses", "version": "1.0.0" }
    ],
    "environment_variables": ${ENV_JSON}
  }
}
JSON
)"

RESPONSE="$(curl -sS -X POST "${FOUNDRY_PROJECT_ENDPOINT}/agents?api-version=v1" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${BODY}")"

echo "${RESPONSE}" | python3 -m json.tool 2>/dev/null || echo "${RESPONSE}"

VERSION="$(echo "${RESPONSE}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)"
if [[ -z "${VERSION}" ]]; then
  echo "!! Could not read a version from the response. Check the error above." >&2
  exit 1
fi

echo "==> Waiting for version ${VERSION} to become active"
for _ in $(seq 1 60); do
  STATUS="$(curl -sS "${FOUNDRY_PROJECT_ENDPOINT}/agents/${AGENT_NAME}/versions/${VERSION}?api-version=v1" \
    -H "Authorization: Bearer ${TOKEN}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status","unknown"))')"
  echo "    status: ${STATUS}"
  case "${STATUS}" in
    active)  echo "==> Deployed. Endpoint:"
             echo "    ${FOUNDRY_PROJECT_ENDPOINT}/agents/${AGENT_NAME}/endpoint/protocols/openai/responses"
             exit 0 ;;
    failed)  echo "!! Deployment failed." >&2; exit 1 ;;
  esac
  sleep 5
done

echo "!! Timed out waiting for the version to become active." >&2
exit 1
