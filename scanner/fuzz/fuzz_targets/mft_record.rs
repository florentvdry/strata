//! File records with arbitrary bytes: parsing, attribute walking, data runs, tree building.
#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| strata_scan::mft::fuzz::record(data));
