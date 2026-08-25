#!/bin/bash
# Provision a fresh affordance sprite: pnpm on the PATH, postgres running as a
# sprite service, and a `sprite` superuser role plus `sprite` database for
# local connections. Safe to re-run.
#
# Run ON the sprite as its default user: write this file to the sprite, then
# execute it with bash. (The sprites exec tool splits its command string on
# whitespace, so the script cannot be passed inline as a quoted argument.)
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# A global npm install puts pnpm in the nvm bin directory, which gets no shim
# on the PATH; link it by hand.
npm install -g pnpm
NODEBIN=$(npm prefix -g)/bin
sudo -n ln -sf "$NODEBIN/pnpm" /usr/local/bin/pnpm
sudo -n ln -sf "$NODEBIN/pnpx" /usr/local/bin/pnpx || true

# postgresql-common must be installed before postgresql: the postgresql
# package's configure step calls pg_lsclusters, which postgresql-common owns.
sudo -n apt-get update -qq
sudo -n apt-get install -y -qq postgresql-common
sudo -n apt-get install -y -qq postgresql
PGVER=$(ls /usr/lib/postgresql | sort -V | tail -1)

# The sprite service runs postgres directly; stop the cluster apt autostarts.
sudo -n pg_ctlcluster "$PGVER" main stop || true

# Trust all local connections. The samehost line is required: the sprite's
# IPv6 loopback is fdf::1, which the ::1/128 rule does not match.
sudo -n tee "/etc/postgresql/$PGVER/main/pg_hba.conf" >/dev/null <<'HBA'
local   all all                 trust
host    all all 127.0.0.1/32    trust
host    all all ::1/128         trust
host    all all samehost        trust
HBA

sudo -n tee /usr/local/bin/run-postgres.sh >/dev/null <<EOF
#!/bin/bash
sudo -n mkdir -p /var/run/postgresql
sudo -n chown postgres:postgres /var/run/postgresql
exec sudo -n -u postgres /usr/lib/postgresql/$PGVER/bin/postgres -D /var/lib/postgresql/$PGVER/main -c config_file=/etc/postgresql/$PGVER/main/postgresql.conf
EOF
sudo -n chmod +x /usr/local/bin/run-postgres.sh

# Register postgres as a sprite service (no http_port) and make sure it runs.
sprite-env services create postgres --cmd /usr/local/bin/run-postgres.sh --no-stream || true
sprite-env services start postgres >/dev/null 2>&1 || true
sleep 2

sudo -n -u postgres psql -c "CREATE ROLE sprite SUPERUSER LOGIN" || true
sudo -n -u postgres psql -c "CREATE DATABASE sprite OWNER sprite" || true

echo "pnpm $(pnpm --version)"
psql -h localhost -U sprite -d sprite -tAc "select 'postgres '||current_setting('server_version')"
echo PROVISION_COMPLETE
