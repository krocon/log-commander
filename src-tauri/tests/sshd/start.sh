#!/bin/sh
# Starts OpenSSH in Docker on 127.0.0.1:2222 for the ignored SFTP tests (prompt 017):
#   tests/sshd/start.sh
#   LC_SSHD_TEST=127.0.0.1:2222 cargo test --test sftp_integration -- --ignored --nocapture
#   tests/sshd/stop.sh
# Keys are throwaway ones in target/sshd-test (key passphrase `test-passphrase`), never your own.
set -e
here=$(cd "$(dirname "$0")" && pwd)
keys="$here/../../target/sshd-test"
rm -rf "$keys" && mkdir -p "$keys"
ssh-keygen -q -t ed25519 -N 'test-passphrase' -C lc-sshd-test -f "$keys/id_ed25519_pass"
ssh-keygen -q -t ed25519 -N '' -f "$keys/ssh_host_ed25519_key"
cp "$here/Dockerfile" "$keys/"
cp "$keys/id_ed25519_pass.pub" "$keys/authorized_keys"
docker build -q -t lc-test-sshd "$keys" >/dev/null
docker rm -f lc-test-sshd >/dev/null 2>&1 || true
docker run -d --rm --name lc-test-sshd -p 127.0.0.1:2222:22 lc-test-sshd >/dev/null
echo "sshd on 127.0.0.1:2222"
