//! strata-scan: see lib.rs for the commands.

#[cfg(target_env = "musl")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // A bug must still end with an error message the main process can show, not a silent crash.
    std::panic::set_hook(Box::new(|info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unexpected error".into());
        let at = info.location().map(|l| format!(" ({}:{})", l.file(), l.line())).unwrap_or_default();
        eprintln!("strata-scan panicked: {msg}{at}");
    }));
    let code = match std::panic::catch_unwind(|| strata_scan::run(&args)) {
        Ok(code) => code,
        Err(p) => {
            let msg = p
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| p.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unexpected error".into());
            strata_scan::report_error(&format!("Internal error: {msg}"));
            1
        }
    };
    std::process::exit(code);
}
