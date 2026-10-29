#!/usr/bin/env bash
# The second release read-back (ADR v2.3 §8): the container Coolify runs for an application was
# created from the registry manifest the release chose. Read-only; run on the VPS:
#
#   ssh adman-vps 'bash -s -- <app-uuid> ghcr.io/artgurianov/mikluha-site-ssr sha256:<hex>' \
#     < scripts/verify-running-digest.sh
#
# An image ID or config digest is not the registry digest, so the proof is the image's RepoDigests.
# poc/coolify-digest/verify-running-digest.sh is the same check, fixed to the PoC repository.
set -euo pipefail

usage='usage: verify-running-digest.sh <app-uuid> <ghcr.io/artgurianov/repo> sha256:<64 hex>'
uuid="${1:?$usage}"
repo="${2:?$usage}"
digest="${3:?$usage}"
[[ "$uuid" =~ ^[a-z0-9]{24}$ ]] || { echo "BAD_UUID $uuid" >&2; exit 2; }
[[ "$repo" =~ ^ghcr\.io/artgurianov/[a-z0-9-]+$ ]] || { echo "BAD_REPO $repo" >&2; exit 2; }
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "BAD_DIGEST $digest" >&2; exit 2; }

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
