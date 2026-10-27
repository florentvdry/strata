// Strata: the Tauri shell around the UI (src/renderer) and the scanner (scanner/).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod platform;
mod scanner;
mod state;
mod store;
mod updates;

fn main() {
    commands::run();
}
