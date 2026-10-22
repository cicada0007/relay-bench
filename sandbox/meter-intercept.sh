#!/bin/sh
# Runs as root inside one benchmark sandbox, before the tool starts, so the cost meter can sit where api.anthropic.com
# and api.openai.com resolve and no tool's endpoint setting has to change (some tools turn features off when it does;
# meter/meter.mjs).
#
# 1. Makes a certificate authority for this one run and one certificate for both provider names, signed by it.
# 2. Deletes the authority's private key at once, so nothing else can ever be signed with it.
# 3. Trusts the authority inside this sandbox only, and points both names at 127.0.0.1, where the meter answers on 443
#    and forwards every request unchanged to the real provider the request was sent to.
#
# Nothing here touches any machine but this sandbox, and the sandbox is destroyed when the run ends.
set -eu
# The runner's PATH is the sandbox user's; update-ca-certificates lives in /usr/sbin.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

dir=/root/meter-tls
mkdir -p "$dir"
chmod 700 "$dir"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=relay-bench meter, one run" \
	-addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
	-keyout "$dir/ca.key" -out "$dir/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=api.anthropic.com" -keyout "$dir/meter.key" -out "$dir/meter.csr" 2>/dev/null
printf 'subjectAltName=DNS:api.anthropic.com,DNS:api.openai.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' >"$dir/ext.cnf"
openssl x509 -req -in "$dir/meter.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial -days 2 \
	-extfile "$dir/ext.cnf" -out "$dir/meter.crt" 2>/dev/null
rm -f "$dir/ca.key" "$dir/meter.csr"

install -m 644 "$dir/ca.crt" /usr/local/share/ca-certificates/relay-bench-meter.crt
update-ca-certificates >/dev/null
echo "127.0.0.1 api.anthropic.com api.openai.com" >>/etc/hosts

mkdir -p /var/lib/relay-bench
chmod 755 /var/lib/relay-bench
echo ready
