#!/bin/sh
# Give EasyTier sockets a dedicated group while keeping root UID/capabilities.
# J-Box marks this group for physical-network bypass before sing-tun's output hook.
set -eu
[ -x /usr/bin/easytier-core ] && [ -f /etc/init.d/easytier ] || exit 0
command -v capsh >/dev/null || { echo 'jbox: EasyTier coexistence needs libcap-bin (capsh)' >&2; exit 1; }
mkdir -p /usr/libexec /opt/j-box/data
cat > /usr/libexec/jbox-easytier-core <<'EOF'
#!/bin/sh
exec /usr/sbin/capsh --gid=20260 -- -c 'exec "$@"' jbox-easytier "$@"
EOF
chmod 755 /usr/libexec/jbox-easytier-core
if ! grep -q 'cd /tmp ; /usr/libexec/jbox-easytier-core' /etc/init.d/easytier; then
  [ -f /opt/j-box/data/easytier-init.before-jbox ] || cp /etc/init.d/easytier /opt/j-box/data/easytier-init.before-jbox
  # Wrap launches only. Keep the configured binary and updater paths unchanged.
  sed -i 's@cd /tmp ; ${easytierbin}@cd /tmp ; /usr/libexec/jbox-easytier-core "${easytierbin}"@g' /etc/init.d/easytier
fi
# An existing process retains its old socket group until restarted.
restart=0
for status in /proc/[0-9]*/status; do
  [ -r "$status" ] || continue
  grep -q '^Name:[[:space:]]*easytier-core$' "$status" || continue
  gid=$(awk '/^Gid:/{print $3}' "$status" 2>/dev/null || true)
  [ "$gid" = 20260 ] || restart=1
done
[ "$restart" = 0 ] || /etc/init.d/easytier restart
exit 0
