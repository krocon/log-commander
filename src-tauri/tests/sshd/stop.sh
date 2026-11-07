#!/bin/sh
# Stops the container of start.sh and removes its image and keys.
here=$(cd "$(dirname "$0")" && pwd)
docker rm -f lc-test-sshd >/dev/null 2>&1 || true
docker rmi lc-test-sshd >/dev/null 2>&1 || true
rm -rf "$here/../../target/sshd-test"
