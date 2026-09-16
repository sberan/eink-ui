fn main() {
    for f in ["NotoSerif-Regular.ttf", "NotoSerif-Bold.ttf"] {
        let p = format!("{}/fonts/{f}", env!("CARGO_MANIFEST_DIR"));
        if std::fs::metadata(&p).is_err() {
            panic!("missing {p}: run ./fonts.sh at the repository root first");
        }
        println!("cargo:rerun-if-changed={p}");
    }
}
