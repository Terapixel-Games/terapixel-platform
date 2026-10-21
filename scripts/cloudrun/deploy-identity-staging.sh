#!/usr/bin/env bash
set -euo pipefail
# Workflow credentials already select the existing OIDC deployment identity.
project=terapixel-platform-staging
region=us-central1
service=terapixel-identity-gateway
account=github-cloudrun-deployer@terapixel-platform-staging.iam.gserviceaccount.com
image="${GATEWAY_IMAGE:?GATEWAY_IMAGE is required}"
[[ "$image" =~ ^us-central1-docker.pkg.dev/terapixel-platform-staging/terapixel-platform/identity-gateway@sha256:[a-f0-9]{64}$ ]]
test "${GITHUB_REF:?}" = refs/heads/main
snapshot_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/gateway-release.XXXXXX")"
trap 'rm -rf "$snapshot_dir"' EXIT
fields='json(metadata.annotations,spec.template.spec.serviceAccountName,spec.template.spec.containers[].env[].name,spec.template.spec.containers[].env[].valueFrom,spec.template.spec.containers[].resources,status.traffic,status.latestReadyRevisionName,status.url)'
snapshot() {
  gcloud run services describe "$service" --account="$account" --project="$project" --region="$region" --format="$fields" > "$snapshot_dir/$1.json"
  gcloud run services get-iam-policy "$service" --account="$account" --project="$project" --region="$region" --format=json > "$snapshot_dir/iam-$1.json"
}
snapshot before
python3 - "$snapshot_dir/before.json" > "$snapshot_dir/prior" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]));t=[x for x in r['status']['traffic'] if x.get('percent',0)>0]
assert len(t)==1 and t[0]['percent']==100,'requires one existing 100% traffic revision'
print(t[0]['revisionName']);print(r['status']['url'])
PY
old_revision="$(sed -n '1p' "$snapshot_dir/prior")"
base_url="$(sed -n '2p' "$snapshot_dir/prior")"
test -n "$old_revision"
test -n "$base_url"
smoke() {
  local label="$1" code
  for route in healthz .well-known/jwks.json v1/web/session; do
    code="$(curl --silent --show-error --max-time 30 --output "$snapshot_dir/body" --write-out '%{http_code}' "$base_url/$route")"
    printf '%s %s %s\n' "$label" "$route" "$code" >> "$snapshot_dir/smoke.txt"
    case "$route" in
      healthz) [[ "$code" = 200 || "$code" = 404 ]]; echo "$code" > "$snapshot_dir/health-$label" ;;
      .well-known/jwks.json) test "$code" = 200; python3 -c 'import json,sys; assert isinstance(json.load(open(sys.argv[1])).get("keys"),list)' "$snapshot_dir/body" ;;
      v1/web/session) test "$code" = 403; python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["error"]["message"] == "missing or invalid edge ingress secret"' "$snapshot_dir/body" ;;
    esac
  done
}
smoke before
{
  echo '### Gateway release baseline'
  echo "- Rollback revision: \`$old_revision\`"
  echo "- Requested image: \`$image\`"
} >> "$GITHUB_STEP_SUMMARY"
new_revision="$(gcloud run services update "$service" --account="$account" --project="$project" --region="$region" --image="$image" --no-traffic --quiet --format='value(status.latestCreatedRevisionName)')"
test -n "$new_revision"
gcloud run revisions describe "$new_revision" --account="$account" --project="$project" --region="$region" --format='json(status.conditions)' | python3 -c 'import json,sys; assert any(c.get("type")=="Ready" and c.get("status")=="True" for c in json.load(sys.stdin)["status"]["conditions"])'
snapshot after
python3 - "$snapshot_dir" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1]);b=json.load(open(p/'before.json'));a=json.load(open(p/'after.json'))
assert b['spec']==a['spec'],'runtime identity/resources/secret references changed'
for key in ['run.googleapis.com/ingress','run.googleapis.com/invoker-iam-disabled']:
 assert b['metadata']['annotations'].get(key)==a['metadata']['annotations'].get(key),'ingress configuration changed'
assert json.load(open(p/'iam-before.json'))==json.load(open(p/'iam-after.json')),'IAM policy changed'
PY
gcloud run services update-traffic "$service" --account="$account" --project="$project" --region="$region" --to-revisions="${new_revision}=100" --quiet
smoke after
cmp "$snapshot_dir/health-before" "$snapshot_dir/health-after"
{
  echo '### Staging identity gateway'
  echo "- Main commit: \`$GITHUB_SHA\`"
  echo "- Image: \`$image\`"
  echo "- Serving revision: \`$new_revision\`"
  echo "- Previous rollback revision: \`$old_revision\`"
  echo '- Runtime metadata, secret references, ingress and IAM unchanged.'
  echo '- Read-only smoke status (health 404 may reflect the existing frontend behavior):'
  cat "$snapshot_dir/smoke.txt"
  echo '- Exchange remains fail-closed until separately approved backend credentials are configured.'
} >> "$GITHUB_STEP_SUMMARY"
