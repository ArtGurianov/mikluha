#!/usr/bin/env bash
# The second release read-back (ADR v2.3 §8): the container Coolify runs for an application was
# created from the registry manifest the release chose. Read-only. By hand on the VPS:
#
#   ssh adman-vps 'bash -s -- <app-uuid> ghcr.io/artgurianov/mikluha-site-ssr sha256:<hex>' \
#     < scripts/verify-running-digest.sh
#
# or as the forced command of the release workflow's attestation key (site-ssr-release.yml), where
# the three arguments arrive in SSH_ORIGINAL_COMMAND and nothing else can run:
#
#   restrict,command="/usr/local/sbin/verify-running-digest" ssh-ed25519 AAAA… site-ssr-attest
#
# `preflight <app-uuid>` checks only that this command is the one answering and can read Docker; the
# release workflow runs it before it changes anything, so a missing or broken credential stops the
# release before the PATCH, not after the deploy.
#
# Two independent facts must hold: the container was created from exactly `repo@digest` (its
# .Config.Image, as Coolify 4.4.6 runs a digest release — ART-360 PoC), and that image's
# RepoDigests contain it. An image ID or config digest is not the registry digest.
# poc/coolify-digest/verify-running-digest.sh is the PoC's older check, fixed to its repository.
set -euo pipefail

if [ "$#" -eq 0 ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  # Word-split on purpose, never globbed: three plain tokens, each validated below before any use.
  set -f
  # shellcheck disable=SC2086
  set -- $SSH_ORIGINAL_COMMAND
  set +f
fi
if [ "$#" -eq 2 ] && [ "$1" = preflight ]; then
  [[ "$2" =~ ^[a-z0-9]{24}$ ]] || { echo "BAD_UUID $2" >&2; exit 2; }
  n="$(docker ps --quiet --filter "name=^$2" | wc -l | tr -d ' ')"
  echo "READY verify-running-digest $2 ($n running)"
  exit 0
fi
[ "$#" -eq 3 ] || { echo "BAD_ARGS expected 3, got $#" >&2; exit 2; }
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
reference="$(docker inspect --format '{{.Config.Image}}' "$c")"
echo "container  $(docker inspect --format '{{.Name}} started {{.State.StartedAt}}' "$c")"
echo "reference  $reference"
echo "image id   $image_id"
echo "repo digests $(docker image inspect --format '{{json .RepoDigests}}' "$image_id")"
[ "$reference" = "$repo@$digest" ] || { echo "FAIL container was created from '$reference', not $repo@$digest"; exit 1; }
if docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" | grep -qxF "$repo@$digest"; then
  echo "PASS running container is $repo@$digest"
else
  echo "FAIL running container is not $repo@$digest"; exit 1
fi
