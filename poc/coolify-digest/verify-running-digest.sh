#!/usr/bin/env bash
# The second read-back (ART-360): the container Coolify runs for the PoC application was created from
# the registry manifest the release chose. Read-only; run on the VPS:
#
#   ssh adman-vps 'bash -s -- <app-uuid> sha256:<hex>' < poc/coolify-digest/verify-running-digest.sh
#
# An image ID or config digest is not the registry digest, so the proof is the image's RepoDigests.
set -euo pipefail

uuid="${1:?usage: verify-running-digest.sh <app-uuid> sha256:<64 hex>}"
digest="${2:?usage: verify-running-digest.sh <app-uuid> sha256:<64 hex>}"
[[ "$uuid" =~ ^[a-z0-9]{24}$ ]] || { echo "BAD_UUID $uuid" >&2; exit 2; }
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "BAD_DIGEST $digest" >&2; exit 2; }
repo=ghcr.io/artgurianov/mikluha-digest-poc

# A rolling update briefly runs the old and the new container side by side.
for _ in $(seq 1 12); do
  mapfile -t containers < <(docker ps --quiet --filter "name=^${uuid}")
  [ "${#containers[@]}" -eq 1 ] && break
  sleep 5
done
[ "${#containers[@]}" -eq 1 ] || { echo "FAIL expected one running container for $uuid, found ${#containers[@]}"; exit 1; }
c="${containers[0]}"
image_id="$(docker inspect --format '{{.Image}}' "$c")"
echo "container  $(docker inspect --format '{{.Name}} started {{.State.StartedAt}}' "$c")"
echo "reference  $(docker inspect --format '{{.Config.Image}}' "$c")"
echo "image id   $image_id"
echo "repo digests $(docker image inspect --format '{{json .RepoDigests}}' "$image_id")"
if docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" | grep -qxF "$repo@$digest"; then
  echo "PASS running container is $repo@$digest"
else
  echo "FAIL running container is not $repo@$digest"; exit 1
fi
