//! Data runs: where a non-resident attribute's clusters are on the disk.

use super::bytes::{i32_at, u16_at};

/// A run of clusters: the first cluster on disk (`None` for a sparse run) and how many.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Run {
    pub lcn: Option<i64>,
    pub clusters: u64,
}

/// Runs of the non-resident attribute at offset `a` of a record.
pub fn parse(rec: &[u8], a: usize) -> Option<Vec<Run>> {
    let mut list = Vec::new();
    let mut p = a + u16_at(rec, a + 0x20)? as usize;
    let end = (a + i32_at(rec, a + 4)?.max(0) as usize).min(rec.len());
    let mut lcn: i64 = 0;
    while p < end && rec[p] != 0 {
        let len_size = (rec[p] & 0xF) as usize;
        let off_size = (rec[p] >> 4) as usize;
        if len_size > 8 || off_size > 8 || p + 1 + len_size + off_size > end {
            return None;
        }
        let mut len: u64 = 0;
        for i in 0..len_size {
            len |= (rec[p + 1 + i] as u64) << (8 * i);
        }
        let mut off: i64 = 0;
        for i in 0..off_size {
            off |= (rec[p + 1 + len_size + i] as i64) << (8 * i);
        }
        // Offsets are signed, relative to the previous run.
        if off_size > 0 && off_size < 8 && rec[p + len_size + off_size] & 0x80 != 0 {
            off |= -1i64 << (8 * off_size);
        }
        p += 1 + len_size + off_size;
        if off_size == 0 {
            list.push(Run { lcn: None, clusters: len });
        } else {
            lcn = lcn.checked_add(off)?;
            list.push(Run { lcn: Some(lcn), clusters: len });
        }
    }
    Some(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_runs_with_negative_offsets_and_holes() {
        // Attribute header with the runs at 0x40.
        let mut rec = vec![0u8; 0x60];
        rec[4..8].copy_from_slice(&0x60i32.to_le_bytes());
        rec[0x20..0x22].copy_from_slice(&0x40u16.to_le_bytes());
        let runs = [
            0x21, 0x10, 0x00, 0x01, // 16 clusters at 256
            0x11, 0x08, 0xF0, // 8 clusters at 256 - 16
            0x01, 0x04, // 4 sparse clusters
            0x00,
        ];
        rec[0x40..0x40 + runs.len()].copy_from_slice(&runs);
        assert_eq!(
            parse(&rec, 0).unwrap(),
            vec![
                Run { lcn: Some(256), clusters: 16 },
                Run { lcn: Some(240), clusters: 8 },
                Run { lcn: None, clusters: 4 },
            ]
        );
    }

    #[test]
    fn rejects_runs_past_the_attribute() {
        let mut rec = vec![0u8; 0x44];
        rec[4..8].copy_from_slice(&0x44i32.to_le_bytes());
        rec[0x20..0x22].copy_from_slice(&0x40u16.to_le_bytes());
        rec[0x40] = 0x88;
        assert_eq!(parse(&rec, 0), None);
    }
}
