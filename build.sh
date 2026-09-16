#!/bin/sh
# Builds everything in Docker (no host toolchain needed):
#   ./build.sh kindle   -> target/armv7-unknown-linux-musleabihf/release/eink-host
#   ./build.sh wasm     -> js/sim/pkg/eink_wasm.wasm (for the simulator and Storybook)
#   ./build.sh test     -> eink-core tests
#   ./build.sh          -> all of the above
set -e
cd "$(dirname "$0")"
IMG=kindle-rs-build
./fonts.sh >/dev/null
docker image inspect $IMG >/dev/null 2>&1 || docker build -q -t $IMG docker
run() { docker run --rm -v "$PWD":/home/rust/src -w /home/rust/src -v kindle-rs-cargo:/root/.cargo/registry \
  -e BINDGEN_EXTRA_CLANG_ARGS="--sysroot=/usr/local/musl/armv7-unknown-linux-musleabihf -I/usr/local/musl/armv7-unknown-linux-musleabihf/include" \
  $IMG sh -c "$1"; }
what=${1:-all}
case "$what" in
  test|all) run 'cargo test --release -p eink-core --target aarch64-unknown-linux-gnu' ;;
esac
case "$what" in
  wasm|all) run 'cargo build --release -p eink-wasm --target wasm32-unknown-unknown && wasm-opt -Os --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int --enable-mutable-globals -o js/sim/pkg/eink_wasm.wasm target/wasm32-unknown-unknown/release/eink_wasm.wasm' && ls -la js/sim/pkg/eink_wasm.wasm ;;
esac
case "$what" in
  kindle|all) run 'cargo build --release -p eink-kindle --target armv7-unknown-linux-musleabihf' && ls -la target/armv7-unknown-linux-musleabihf/release/eink-host ;;
esac
