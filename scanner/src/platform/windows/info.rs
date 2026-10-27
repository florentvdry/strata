//! Drives: letters, labels, sizes, and bus and SSD/HDD from the storage driver (IOCTL_STORAGE_QUERY_PROPERTY).

use super::{cluster_size, space, volume_names, wide};
use serde_json::{Value, json};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, GetDriveTypeW, GetLogicalDrives, OPEN_EXISTING,
};
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Ioctl::{
    DEVICE_SEEK_PENALTY_DESCRIPTOR, IOCTL_STORAGE_QUERY_PROPERTY, PropertyStandardQuery, STORAGE_DEVICE_DESCRIPTOR,
    STORAGE_PROPERTY_QUERY, StorageDeviceProperty, StorageDeviceSeekPenaltyProperty,
};
use windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub fn is_elevated() -> bool {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut e = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            (&mut e as *mut TOKEN_ELEVATION).cast(),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        CloseHandle(token);
        ok != 0 && e.TokenIsElevated != 0
    }
}

/// STORAGE_BUS_TYPE → name.
fn bus_name(t: i32) -> Option<&'static str> {
    Some(match t {
        1 => "SCSI",
        2 => "ATAPI",
        3 => "ATA",
        4 => "FireWire",
        6 => "Fibre Channel",
        7 => "USB",
        8 => "RAID",
        9 => "iSCSI",
        10 => "SAS",
        11 => "SATA",
        12 => "SD",
        13 => "MMC",
        14 | 15 => "Virtual",
        16 => "Storage Spaces",
        17 => "NVMe",
        18 => "SCM",
        19 => "UFS",
        _ => return None,
    })
}

fn query<T>(h: HANDLE, property: i32, out: &mut T) -> bool {
    let q =
        STORAGE_PROPERTY_QUERY { PropertyId: property, QueryType: PropertyStandardQuery, AdditionalParameters: [0] };
    let mut ret = 0u32;
    unsafe {
        DeviceIoControl(
            h,
            IOCTL_STORAGE_QUERY_PROPERTY,
            (&q as *const STORAGE_PROPERTY_QUERY).cast(),
            size_of::<STORAGE_PROPERTY_QUERY>() as u32,
            (out as *mut T).cast(),
            size_of::<T>() as u32,
            &mut ret,
            std::ptr::null_mut(),
        ) != 0
    }
}

/// Bus (NVMe, SATA, USB…) and media (SSD/HDD) of the disk behind a drive letter. No administrator rights needed.
fn hardware(letter: char) -> (Option<&'static str>, Option<&'static str>) {
    let w = wide(format!(r"\\.\{letter}:"));
    let h = unsafe {
        CreateFileW(
            w.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if h == INVALID_HANDLE_VALUE {
        return (None, None);
    }
    let mut desc: STORAGE_DEVICE_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let bus = if query(h, StorageDeviceProperty, &mut desc) { bus_name(desc.BusType) } else { None };
    let mut seek: DEVICE_SEEK_PENALTY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let media = if bus == Some("SCM") {
        Some("SCM")
    } else if query(h, StorageDeviceSeekPenaltyProperty, &mut seek) {
        // Flash drives and SD cards report no seek penalty but aren't what people call an SSD.
        if seek.IncursSeekPenalty {
            Some("HDD")
        } else if matches!(bus, Some("USB" | "SD" | "MMC" | "Virtual")) {
            None
        } else {
            Some("SSD")
        }
    } else {
        None
    };
    unsafe { CloseHandle(h) };
    (bus, media)
}

fn system_root() -> String {
    let mut buf = [0u16; 261];
    let n = unsafe { GetWindowsDirectoryW(buf.as_mut_ptr(), 261) } as usize;
    let dir = String::from_utf16_lossy(&buf[..n.min(261)]);
    if dir.len() >= 2 { format!("{}\\", &dir[..2]) } else { "C:\\".into() }
}

fn kind_name(t: u32) -> &'static str {
    match t {
        2 => "Removable",
        3 => "Fixed",
        4 => "Network",
        5 => "CDRom",
        6 => "Ram",
        1 => "NoRootDirectory",
        _ => "Unknown",
    }
}

pub fn drives() -> Vec<Value> {
    let sys = system_root();
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{letter}:\\");
        let t = unsafe { GetDriveTypeW(wide(&root).as_ptr()) };
        if t == 5 {
            continue; // CD/DVD
        }
        // Not ready (empty card reader, disconnected network drive): left out.
        let (Some((fs, label)), Some((total, free))) = (volume_names(&root), space(&root)) else {
            continue;
        };
        let kind = kind_name(t);
        let (mut bus, media) = if t == 4 { (None, None) } else { hardware(letter) };
        if t == 4 {
            bus = Some("Network");
        }
        if t == 2 && bus.is_none() {
            bus = Some("Removable");
        }
        out.push(json!({
            "letter": letter.to_string(),
            "root": root,
            "label": label,
            "fs": fs,
            "total": total,
            "free": free,
            "kind": kind,
            "bus": bus,
            "media": media,
            "cluster": cluster_size(&root),
            "system": root.eq_ignore_ascii_case(&sys),
        }));
    }
    out
}
