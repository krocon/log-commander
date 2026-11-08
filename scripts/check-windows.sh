#!/bin/sh
# Type-checks and lints the Rust crate for Windows on macOS/Linux (prompt 018): `cargo clippy --all-targets`
# for x86_64-pc-windows-msvc and -gnu. Only the Rust code is checked. The C parts (ring, bundled SQLite) and
# the Windows resource file need the Windows SDK, so stand-ins write empty objects. Nothing is linked or run.
# Needs: rustup target add x86_64-pc-windows-msvc x86_64-pc-windows-gnu
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
fake=$(mktemp -d)
trap 'rm -rf "$fake"' EXIT

cat > "$fake/fake-cc" <<'EOF'
#!/bin/sh
out=""; prev=""
for a in "$@"; do
  case "$prev" in -o) out="$a";; esac
  case "$a" in -Fo*) out="${a#-Fo}";; /Fo*) out="${a#/Fo}";; esac
  prev="$a"
done
[ -n "$out" ] && : > "$out"
exit 0
EOF
cat > "$fake/fake-ar" <<'EOF'
#!/bin/sh
for a in "$@"; do
  case "$a" in -out:*|/OUT:*|-OUT:*) : > "${a#*:}";; *.a|*.lib) : > "$a";; esac
done
exit 0
EOF
cat > "$fake/llvm-rc" <<'EOF'
#!/bin/sh
prev=""
for a in "$@"; do [ "$prev" = "/fo" ] && : > "$a"; prev="$a"; done
exit 0
EOF
cat > "$fake/x86_64-w64-mingw32-windres" <<'EOF'
#!/bin/sh
prev=""
for a in "$@"; do [ "$prev" = "--output" ] && : > "$a"; prev="$a"; done
exit 0
EOF
chmod +x "$fake"/*

for target in x86_64-pc-windows-msvc x86_64-pc-windows-gnu; do
  var=$(echo "$target" | tr '-' '_')
  echo "== $target"
  env PATH="$fake:$PATH" "CC_$var=$fake/fake-cc" "AR_$var=$fake/fake-ar" \
    CARGO_TARGET_DIR="$root/src-tauri/target/windows-check" \
    cargo clippy --target "$target" --manifest-path "$root/src-tauri/Cargo.toml" --all-targets -- -D warnings
done
