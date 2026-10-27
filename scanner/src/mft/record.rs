//! File records: the "FILE" signature, update-sequence fixups, and walking a record's attributes.

use super::bytes::{i32_at, u16_at};

pub const STANDARD_INFORMATION: i32 = 0x10;
pub const ATTRIBUTE_LIST: i32 = 0x20;
pub const FILE_NAME: i32 = 0x30;
pub const DATA: i32 = 0x80;

/// Checks the signature and puts back the last two bytes of each sector (saved in the update sequence array).
/// Returns false for a record that isn't one or was torn while being written.
pub fn fixup(rec: &mut [u8]) -> bool {
    let size = rec.len();
    if rec.get(..4) != Some(b"FILE") {
        return false;
    }
    let (Some(usa_ofs), Some(usa_count)) = (u16_at(rec, 4), u16_at(rec, 6)) else {
        return false;
    };
    let (usa_ofs, usa_count) = (usa_ofs as usize, usa_count as usize);
    if usa_ofs + usa_count * 2 > size {
        return false;
    }
    if usa_count < 2 {
        return true;
    }
    let Some(usn) = u16_at(rec, usa_ofs) else {
        return false;
    };
    // 512 normally; the sector size on some 4K-native disks.
    let stride = size / (usa_count - 1);
    for i in 1..usa_count {
        let pos = i * stride;
        if pos < 2 || pos > size {
            break;
        }
        let pos = pos - 2;
        if u16_at(rec, pos) != Some(usn) {
            return false;
        }
        rec[pos] = rec[usa_ofs + i * 2];
        rec[pos + 1] = rec[usa_ofs + i * 2 + 1];
    }
    true
}

/// Calls `visit(type, offset)` for each attribute of a fixed-up record.
pub fn for_each_attr(rec: &[u8], mut visit: impl FnMut(i32, usize)) {
    let Some(first) = u16_at(rec, 0x14) else {
        return;
    };
    let mut a = first as usize;
    let end = rec.len();
    while a + 16 <= end {
        let Some(t) = i32_at(rec, a) else { break };
        if t == -1 {
            break;
        }
        let Some(len) = i32_at(rec, a + 4) else { break };
        if len <= 0 || a + len as usize > end {
            break;
        }
        visit(t, a);
        a += len as usize;
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A 1 KB record with two sectors, as NTFS writes it: the last two bytes of each sector replaced by the USN.
    pub fn record_with_fixups(body: &[(usize, &[u8])]) -> Vec<u8> {
        let mut r = vec![0u8; 1024];
        r[..4].copy_from_slice(b"FILE");
        r[4..6].copy_from_slice(&0x30u16.to_le_bytes());
        r[6..8].copy_from_slice(&3u16.to_le_bytes());
        for (o, b) in body {
            r[*o..*o + b.len()].copy_from_slice(b);
        }
        let usn = [0x42, 0x00];
        r[0x30..0x32].copy_from_slice(&usn);
        for i in 1..3 {
            let pos = i * 512 - 2;
            let saved = [r[pos], r[pos + 1]];
            r[0x30 + i * 2..0x30 + i * 2 + 2].copy_from_slice(&saved);
            r[pos..pos + 2].copy_from_slice(&usn);
        }
        r
    }

    #[test]
    fn fixups_restore_sector_ends_and_catch_torn_records() {
        let mut r = record_with_fixups(&[(510, &[1, 2]), (1022, &[3, 4])]);
        assert!(fixup(&mut r));
        assert_eq!(&r[510..512], &[1, 2]);
        assert_eq!(&r[1022..1024], &[3, 4]);
        let mut torn = record_with_fixups(&[]);
        torn[1022] = 9;
        assert!(!fixup(&mut torn));
        let mut not_a_record = vec![0u8; 1024];
        assert!(!fixup(&mut not_a_record));
    }
}
