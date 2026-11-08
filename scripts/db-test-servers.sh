#!/bin/sh
# Throwaway database servers with TLS for the ignored integration tests of prompt 019
# (src-tauri/tests/db_integration.rs): PostgreSQL 17, MySQL 8.4, MariaDB 11.4 and SQL Server 2022 in
# Docker, each on 127.0.0.1 only, with a certificate from a CA made here (test passwords, nothing kept).
#
#   sh scripts/db-test-servers.sh up      # certificates, containers, waits until all answer
#   cd src-tauri && LC_DB_TEST_DIR=${TMPDIR:-/tmp}/lc-db-test cargo test --test db_integration -- --ignored --test-threads=1
#   sh scripts/db-test-servers.sh down    # removes containers and certificates
#
# SQL Server runs as linux/amd64 (emulated on Apple Silicon, ~30 s to start).
set -eu
base="${TMPDIR:-/tmp}"
dir="${base%/}/lc-db-test"
pw="Lc-test-019!"

case "${1:-}" in
up)
  mkdir -p "$dir"
  cd "$dir"
  if [ ! -f ca.pem ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 7 -subj "/CN=LC Test CA" 2>/dev/null
    openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
    printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" > ext.cnf
    openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 7 -extfile ext.cnf 2>/dev/null
    chmod 644 server.key
    printf "[network]\ntlscert = /certs/server.pem\ntlskey = /certs/server.key\ntlsprotocols = 1.2\nforceencryption = 1\n" > mssql.conf
  fi
  docker run -d --rm --name lc-dbtest-pg -p 127.0.0.1:15432:5432 -e POSTGRES_PASSWORD="$pw" -v "$dir":/certs:ro \
    postgres:17-alpine sh -c 'cp /certs/server.pem /certs/server.key /tmp/ && chown postgres /tmp/server.* && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.pem -c ssl_key_file=/tmp/server.key' >/dev/null
  docker run -d --rm --name lc-dbtest-my -p 127.0.0.1:13306:3306 -e MYSQL_ROOT_PASSWORD="$pw" -e MYSQL_DATABASE=logs -v "$dir":/certs:ro \
    mysql:8.4 --ssl-ca=/certs/ca.pem --ssl-cert=/certs/server.pem --ssl-key=/certs/server.key --log-bin-trust-function-creators=1 >/dev/null
  docker run -d --rm --name lc-dbtest-maria -p 127.0.0.1:13307:3306 -e MARIADB_ROOT_PASSWORD="$pw" -e MARIADB_DATABASE=logs -v "$dir":/certs:ro \
    mariadb:11.4 --ssl-ca=/certs/ca.pem --ssl-cert=/certs/server.pem --ssl-key=/certs/server.key >/dev/null
  docker run -d --rm --name lc-dbtest-ms --platform linux/amd64 -p 127.0.0.1:11433:1433 -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="$pw" \
    -v "$dir":/certs:ro --entrypoint /bin/bash mcr.microsoft.com/mssql/server:2022-latest \
    -c 'cp /certs/mssql.conf /var/opt/mssql/mssql.conf; exec /opt/mssql/bin/sqlservr' >/dev/null
  printf "waiting for the servers"
  for _ in $(seq 1 90); do
    ok=0
    docker exec lc-dbtest-pg pg_isready -q -U postgres 2>/dev/null && ok=$((ok + 1))
    docker exec lc-dbtest-my mysqladmin ping -uroot -p"$pw" --silent 2>/dev/null | grep -q alive && ok=$((ok + 1))
    docker exec lc-dbtest-maria healthcheck.sh --connect 2>/dev/null && ok=$((ok + 1))
    docker logs lc-dbtest-ms 2>&1 | grep -q "Recovery is complete" && ok=$((ok + 1))
    [ "$ok" -eq 4 ] && { echo " ready"; echo "LC_DB_TEST_DIR=$dir"; exit 0; }
    printf "."
    sleep 2
  done
  echo " not all servers came up" >&2
  exit 1
  ;;
down)
  docker rm -f lc-dbtest-pg lc-dbtest-my lc-dbtest-maria lc-dbtest-ms >/dev/null 2>&1 || true
  rm -rf "$dir"
  ;;
*)
  echo "usage: $0 up|down" >&2
  exit 2
  ;;
esac
