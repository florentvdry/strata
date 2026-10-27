//! File-type categories, by extension. Indices are shared with the UI (src/renderer/lib/types.js).

use std::collections::HashMap;
use std::sync::LazyLock;

pub const OTHER: u8 = 0;
pub const VIDEO: u8 = 1;
pub const APP: u8 = 2;
pub const SYSTEM: u8 = 3;
pub const IMAGE: u8 = 4;
pub const ARCHIVE: u8 = 5;
pub const CODE: u8 = 6;
pub const AUDIO: u8 = 7;
pub const DOC: u8 = 8;
pub const COUNT: usize = 9;

// Later lists win when an extension appears twice ("ts" is code, not a video stream).
const LISTS: &[(u8, &str)] = &[
    (VIDEO, "mp4 mkv avi mov wmv webm m4v flv mpg mpeg ts m2ts mts vob 3gp ogv rm rmvb divx f4v braw r3d prproj"),
    (
        APP,
        "exe dll pak vpk uasset uexp ubulk utoc ucas bundle assets resource resS forge rpf big ba2 bsa esm esp wad gcf vdf acf sav \
         sys32 ocx appx msix appxbundle msixbundle apk xapk ipa so dylib bik bnk wem pck arc dat001 cache0 xnb pdx ff ipak xpak \
         sabs sabl tre pck2 unity3d obb blob appimage flatpak",
    ),
    (
        SYSTEM,
        "sys log etl evtx tmp temp mui cat manifest ini reg dmp mdmp hdmp edb jfm chk blf regtrans-ms evt cpl drv efi mum inf pnf \
         dat db db-wal db-shm sqlite ldb lock lck trace etw pf journal journal~ core",
    ),
    (
        IMAGE,
        "jpg jpeg png gif bmp tif tiff webp heic heif avif raw cr2 cr3 nef arw dng orf rw2 raf psd psb xcf kra svg ico icns tga \
         exr hdr lrcat lrdata dds jxl afphoto",
    ),
    (
        ARCHIVE,
        "zip rar 7z tar gz tgz bz2 xz zst lz lzma cab iso img vhd vhdx vmdk vdi qcow2 dmg wim esd msi msp msu nupkg crx xpi bak \
         backup tib deb rpm snap",
    ),
    (
        CODE,
        "js mjs cjs ts tsx jsx py pyc pyd java class jar war c cc cpp cxx h hpp cs vb fs go rs rb php swift kt kts scala lua pl r \
         m mm sh ps1 psm1 bat cmd json yaml yml toml xml map wasm o obj lib a pdb ilk idb ipch pch whl gem crate node gradle sln \
         csproj vcxproj nuspec css scss less html htm vue svelte sql ipynb",
    ),
    (AUDIO, "mp3 wav flac aac ogg oga m4a wma opus aiff aif mid midi ape alac wv dsf amr caf"),
    (
        DOC,
        "pdf doc docx xls xlsx xlsm ppt pptx txt md rtf odt ods odp csv tsv epub mobi azw3 pages numbers key one pst ost msg eml \
         vsdx pub tex djvu xps oxps chm",
    ),
];

static EXT: LazyLock<HashMap<String, u8>> = LazyLock::new(|| {
    let mut map = HashMap::new();
    for &(t, list) in LISTS {
        for e in list.split_whitespace() {
            map.insert(e.to_lowercase(), t);
        }
    }
    map
});

/// Category of a file name (or a path: only what follows the last dot counts).
pub fn classify(name: &str) -> u8 {
    let Some(dot) = name.rfind('.') else {
        return OTHER;
    };
    if dot == 0 || dot == name.len() - 1 {
        return OTHER;
    }
    let ext = &name[dot + 1..];
    if let Some(&t) = EXT.get(ext) {
        return t;
    }
    if let Some(&t) = EXT.get(&ext.to_lowercase()) {
        return t;
    }
    if is_versioned_shared_library(name) { APP } else { OTHER }
}

/// libfoo.so.1.2: ends with ".so" followed by one or more ".<digits>".
fn is_versioned_shared_library(name: &str) -> bool {
    let mut rest = name;
    let mut groups = 0;
    while let Some(dot) = rest.rfind('.') {
        let tail = &rest[dot + 1..];
        if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
            break;
        }
        rest = &rest[..dot];
        groups += 1;
    }
    groups > 0 && rest.ends_with(".so")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_last_extension() {
        assert_eq!(classify("movie.MKV"), VIDEO);
        assert_eq!(classify("archive.tar.gz"), ARCHIVE);
        assert_eq!(classify("index.ts"), CODE);
        assert_eq!(classify("data.resS"), APP);
        assert_eq!(classify(".bashrc"), OTHER);
        assert_eq!(classify("trailing."), OTHER);
        assert_eq!(classify("noext"), OTHER);
        assert_eq!(classify("dir.d/file"), OTHER);
        assert_eq!(classify("Strata.AppImage"), APP);
        assert_eq!(classify("strata_0.2.0_amd64.deb"), ARCHIVE);
        assert_eq!(classify("system.journal"), SYSTEM);
    }

    #[test]
    fn versioned_shared_libraries_are_apps() {
        assert_eq!(classify("libfoo.so"), APP);
        assert_eq!(classify("libfoo.so.1"), APP);
        assert_eq!(classify("libfoo.so.1.2.3"), APP);
        assert_eq!(classify("libfoo.so.x"), OTHER);
        assert_eq!(classify("notes.1"), OTHER);
    }

    /// Every extension the UI knows (src/renderer/lib/types.js, used for names the scanner didn't classify)
    /// must land in the same category here.
    #[test]
    fn agrees_with_the_ui() {
        let js = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/renderer/lib/types.js")).unwrap();
        let ids = ["other", "video", "app", "system", "image", "archive", "code", "audio", "doc"];
        let block = &js[js.find("const EXT = {").unwrap()..];
        let block = &block[..block.find("};").unwrap()];
        let mut checked = 0;
        for line in block.lines() {
            let Some((key, value)) = line.trim().split_once(':') else {
                continue;
            };
            let Some(t) = ids.iter().position(|id| *id == key.trim()) else {
                continue;
            };
            let list = value.trim().trim_end_matches(',').trim_matches('\'');
            for ext in list.split_whitespace() {
                assert_eq!(classify(&format!("x.{ext}")) as usize, t, "extension {ext}");
                checked += 1;
            }
        }
        assert!(checked > 50, "parsed the UI's list");
    }
}
