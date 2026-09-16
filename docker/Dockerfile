FROM messense/rust-musl-cross:armv7-musleabihf
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libclang-dev make binaryen >/dev/null && rm -rf /var/lib/apt/lists/*
RUN rustup target add armv7-unknown-linux-musleabihf wasm32-unknown-unknown 2>/dev/null; rustc --version
