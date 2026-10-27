use std::path::PathBuf;

// The scanner (../scanner, built by `npm run build:scanner` into ../bin) is embedded in the app and
// extracted on first run, so the portable build stays one file. Without it (cargo check, tests) the
// app falls back to ../bin at run time.
fn main() {
    let name = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        "strata-scan.exe"
    } else {
        "strata-scan"
    };
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let scanner = manifest.join("..").join("bin").join(name);
    println!("cargo:rerun-if-changed={}", scanner.display());
    println!("cargo:rerun-if-env-changed=STRATA_SCANNER");
    let chosen = std::env::var_os("STRATA_SCANNER").map(PathBuf::from).unwrap_or(scanner);
    let embedded = if chosen.exists() {
        chosen.canonicalize().unwrap()
    } else {
        println!(
            "cargo:warning=scanner not found at {} — run `npm run build:scanner`; the app will look in bin/ at run time",
            chosen.display()
        );
        let empty = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("no-scanner");
        std::fs::write(&empty, []).unwrap();
        empty
    };
    println!("cargo:rustc-env=STRATA_SCANNER_EMBEDDED={}", embedded.display());
    tauri_build::build();
}
