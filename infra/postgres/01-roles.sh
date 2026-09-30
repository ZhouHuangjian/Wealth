#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${DB_OWNER_PASSWORD:?DB_OWNER_PASSWORD is required}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD is required}"

# Values are quoted by psql; no password is interpolated into shell-generated SQL.
psql --username "${POSTGRES_USER:-postgres}" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=db="$POSTGRES_DB" \
  --set=owner_password="$DB_OWNER_PASSWORD" --set=app_password="$DB_APP_PASSWORD" <<'SQL'
CREATE ROLE wealth_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE wealth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE wealth_owner PASSWORD :'owner_password';
ALTER ROLE wealth_app PASSWORD :'app_password';
ALTER DATABASE :"db" OWNER TO wealth_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO wealth_owner, wealth_app;
ALTER SCHEMA public OWNER TO wealth_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO wealth_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wealth_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wealth_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wealth_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wealth_app;
SQL
