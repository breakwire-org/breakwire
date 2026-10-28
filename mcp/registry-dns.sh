#!/usr/bin/env bash
# MCP Registry publishing for org.breakwire/breakwire with DNS auth on breakwire.org.
# Follows https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx (read 2026-10-28).
# Usage: ./registry-dns.sh keygen | txt | check | login | publish | verify
# The private key stays OUTSIDE the repo (default ~/.config/breakwire/mcp-registry-ed25519.pem, chmod 600). Never commit it.
set -euo pipefail
DOMAIN="breakwire.org"
KEY="${BREAKWIRE_MCP_KEY:-$HOME/.config/breakwire/mcp-registry-ed25519.pem}"
HERE="$(cd "$(dirname "$0")" && pwd)"
pub() { openssl pkey -in "$KEY" -pubout -outform DER | tail -c 32 | base64; }
case "${1:-}" in
  keygen)
    [ -e "$KEY" ] && { echo "exists: $KEY (refusing to overwrite)"; exit 1; }
    mkdir -p "$(dirname "$KEY")"; umask 077
    openssl genpkey -algorithm Ed25519 -out "$KEY"   # needs OpenSSL 3 (macOS: brew install openssl@3)
    echo "private key: $KEY"; "$0" txt ;;
  txt)
    echo "Add this TXT record at the APEX of $DOMAIN (name '@' / '$DOMAIN', NOT _mcp-auth.$DOMAIN):"
    echo "  $DOMAIN. IN TXT \"v=MCPv1; k=ed25519; p=$(pub)\"" ;;
  check)
    echo "Public resolvers (both should show the v=MCPv1 record):"
    curl -s "https://dns.google/resolve?name=$DOMAIN&type=TXT" | grep -o 'v=MCPv1[^"\\]*' || echo "  dns.google: not yet"
    curl -s -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=$DOMAIN&type=TXT" | grep -o 'v=MCPv1[^"\\]*' || echo "  1.1.1.1: not yet" ;;
  login)
    PRIVATE_KEY="$(openssl pkey -in "$KEY" -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
    mcp-publisher login dns --domain "$DOMAIN" --private-key "$PRIVATE_KEY" ;;
  publish)
    mcp-publisher validate "$HERE/server.json"
    (cd "$HERE" && mcp-publisher publish) ;;
  verify)
    curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=org.breakwire/breakwire" ; echo ;;
  *) echo "usage: $0 keygen | txt | check | login | publish | verify"; exit 2 ;;
esac
