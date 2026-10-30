#!/bin/sh
# Per-run disposable trust. No private TLS key is committed or reused as a service credential.
set -eu
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT HUP INT TERM
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$fixture_dir/key.pem" -out "$fixture_dir/ca.pem" -days 1 \
  -subj '/CN=TOUR-63 disposable TLS fixture' \
  -addext 'subjectAltName=IP:127.0.0.1' >/dev/null 2>&1
export MEDIA_TEST_TLS_KEY="$fixture_dir/key.pem"
export MEDIA_TEST_TLS_CERT="$fixture_dir/ca.pem"
export NODE_EXTRA_CA_CERTS="$fixture_dir/ca.pem"
"$@"
