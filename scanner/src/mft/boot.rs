//! The NTFS boot sector: cluster, sector and file-record sizes, and where the master file table starts.

use super::bytes::{i64_at, u8_at, u16_at};
use std::io;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Boot {
    pub sector_size: u64,
    pub cluster_size: u64,
    pub record_size: u64,
    pub mft_lcn: i64,
    /// Volume size, in bytes.
    pub volume_size: u64,
}

fn bad(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_owned())
}

pub fn parse(b: &[u8]) -> io::Result<Boot> {
    if b.get(3..7) != Some(b"NTFS") {
        return Err(bad("not an NTFS boot sector"));
    }
    let sector_size = u16_at(b, 0x0B).ok_or_else(|| bad("boot sector"))? as u64;
    let mut spc = u8_at(b, 0x0D).ok_or_else(|| bad("boot sector"))? as u64;
    // Above 0x80, the value is a negative power of two (clusters over 64 KB).
    if spc > 0x80 {
        spc = 1 << (256 - spc).min(31);
    }
    let cluster_size = sector_size * spc;
    let mft_lcn = i64_at(b, 0x30).ok_or_else(|| bad("boot sector"))?;
    let volume_size = (i64_at(b, 0x28).ok_or_else(|| bad("boot sector"))?.max(0) as u64).saturating_mul(sector_size);
    let cpr = u8_at(b, 0x40).ok_or_else(|| bad("boot sector"))? as i8;
    let record_size = if cpr > 0 { cpr as u64 * cluster_size } else { 1u64 << (-(cpr as i32)).clamp(0, 31) };
    if !sector_size.is_power_of_two()
        || sector_size < 256
        || cluster_size == 0
        || !(256..=65536).contains(&record_size)
        || mft_lcn < 0
    {
        return Err(bad("unexpected boot sector values"));
    }
    Ok(Boot { sector_size, cluster_size, record_size, mft_lcn, volume_size })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_typical_boot_sector() {
        let mut b = vec![0u8; 512];
        b[3..7].copy_from_slice(b"NTFS");
        b[0x0B..0x0D].copy_from_slice(&512u16.to_le_bytes());
        b[0x0D] = 8;
        b[0x28..0x30].copy_from_slice(&1_000_000i64.to_le_bytes());
        b[0x30..0x38].copy_from_slice(&786432i64.to_le_bytes());
        b[0x40] = 0xF6; // -10: 1024-byte records
        assert_eq!(
            parse(&b).unwrap(),
            Boot { sector_size: 512, cluster_size: 4096, record_size: 1024, mft_lcn: 786432, volume_size: 512_000_000 }
        );
        b[3] = b'X';
        assert!(parse(&b).is_err());
    }
}
