#!/bin/sh
# Headed Chrome needs an X display: run the service under a private Xvfb
# sized like the browser window. HEADLESS=true skips Xvfb entirely.
set -eu

case "$(printf '%s' "${HEADLESS:-false}" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes) exec "$@" ;;
esac

W="${WINDOW_WIDTH:-1920}"
H="${WINDOW_HEIGHT:-1080}"
exec xvfb-run --auto-servernum --server-args="-screen 0 ${W}x${H}x24 -nolisten tcp" "$@"
