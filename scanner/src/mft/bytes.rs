//! Bounds-checked little-endian reads: a damaged record gives `None`, never a crash.

pub fn u8_at(b: &[u8], o: usize) -> Option<u8> {
    b.get(o).copied()
}

pub fn u16_at(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(o..o.checked_add(2)?)?.try_into().ok()?))
}

pub fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(o..o.checked_add(4)?)?.try_into().ok()?))
}

pub fn i32_at(b: &[u8], o: usize) -> Option<i32> {
    u32_at(b, o).map(|v| v as i32)
}

pub fn i64_at(b: &[u8], o: usize) -> Option<i64> {
    Some(i64::from_le_bytes(b.get(o..o.checked_add(8)?)?.try_into().ok()?))
}

/// A file reference: the low 48 bits are the record number.
pub fn file_ref(b: &[u8], o: usize) -> Option<u64> {
    i64_at(b, o).map(|v| (v as u64) & 0xFFFF_FFFF_FFFF)
}

pub fn utf16_at(b: &[u8], o: usize, chars: usize) -> Option<String> {
    let s = b.get(o..o.checked_add(chars * 2)?)?;
    let units: Vec<u16> = s.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    Some(String::from_utf16_lossy(&units))
}
