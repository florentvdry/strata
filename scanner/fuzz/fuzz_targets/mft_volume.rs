//! Whole volume images with arbitrary bytes: boot sector, $MFT layout, extension records, reading every record.
#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| strata_scan::mft::fuzz::volume(data));
