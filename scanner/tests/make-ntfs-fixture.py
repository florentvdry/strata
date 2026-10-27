#!/usr/bin/env python3
"""Builds the NTFS disk images the fast-scan tests read (scanner/tests/fixtures/*.img.zst + *.json).

Needs Linux, root (for the FUSE mount), mkntfs and ntfs-3g (package ntfs-3g) and zstd.

    sudo python3 scanner/tests/make-ntfs-fixture.py [out_dir]

Each image comes with what the mounted file system showed: every path with its size, attributes, record number
(inode), link count and modification time. The test checks that the MFT reader finds the same tree.
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, 'fixtures')

ATTR_HIDDEN, ATTR_SYSTEM, ATTR_READONLY, ATTR_COMPRESSED = 0x2, 0x4, 0x1, 0x800


def run(*cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def attrib(p):
    try:
        return struct.unpack('<I', os.getxattr(p, 'system.ntfs_attrib', follow_symlinks=False))[0]
    except OSError:
        return 0


def set_attrib(p, add):
    os.setxattr(p, 'system.ntfs_attrib', struct.pack('<I', attrib(p) | add), follow_symlinks=False)


def write(root, rel, size, fill=b'a'):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'wb') as f:
        f.write((fill * (size // len(fill) + 1))[:size])
    return p


def populate_basic(m):
    # Resident (tiny) and non-resident files, many types, deep folders, non-ASCII names.
    write(m, 'docs/report.pdf', 120_000)
    write(m, 'docs/notes.txt', 300)
    write(m, 'docs/empty.txt', 0)
    write(m, 'video/movie.mkv', 3_000_000, b'video')
    write(m, 'deep/' + '/'.join(f'level{i}' for i in range(20)) + '/bottom.bin', 4567)
    write(m, 'names/café 中文 \U0001F600.txt', 42)
    write(m, 'names/' + 'long-name-' * 20 + '.md', 7)
    os.makedirs(os.path.join(m, 'empty-dir'))
    # Win32 + DOS 8.3 names: the long name must win.
    dos = write(m, 'names/A long file name.txt', 99)
    os.setxattr(dos, 'system.ntfs_dos_name', b'ALONGF~1.TXT')
    # Hidden and system items.
    set_attrib(write(m, 'attrs/hidden.txt', 11), ATTR_HIDDEN)
    set_attrib(write(m, 'attrs/system.txt', 12), ATTR_SYSTEM)
    set_attrib(write(m, 'attrs/readonly.txt', 13), ATTR_READONLY)
    hd = os.path.join(m, 'attrs/hidden-dir')
    os.makedirs(hd)
    write(m, 'attrs/hidden-dir/inside.txt', 14)
    set_attrib(hd, ATTR_HIDDEN)
    # Sparse: 20 MB long, nothing written.
    with open(os.path.join(m, 'sparse.vhd'), 'wb') as f:
        f.truncate(20 * 1024 * 1024)
    # Alternate data stream: not part of the file's size.
    write(m, 'streams/with-ads.txt', 1000)
    with open(os.path.join(m, 'streams/with-ads.txt:secret'), 'wb') as f:
        f.write(b'x' * 50_000)
    # Fragmented: two files written in turns.
    with open(os.path.join(m, 'frag-a.bin'), 'wb') as a, open(os.path.join(m, 'frag-b.bin'), 'wb') as b:
        for _ in range(40):
            a.write(b'A' * 16384)
            a.flush()
            b.write(b'B' * 16384)
            b.flush()
    # Compressed folder: files inside get compressed.
    cd = os.path.join(m, 'compressed')
    os.makedirs(cd)
    try:
        set_attrib(cd, ATTR_COMPRESSED)
    except OSError:
        pass
    write(m, 'compressed/big.log', 500_000, b'log line\n')
    # Hard links: one file, several names. The fast scan shows it once.
    write(m, 'links/original.dat', 8000)
    for i in range(3):
        os.link(os.path.join(m, 'links/original.dat'), os.path.join(m, f'links/alias{i}.dat'))
    # So many names that the record overflows into an extension record ($ATTRIBUTE_LIST).
    os.makedirs(os.path.join(m, 'many-links'))
    write(m, 'many-links/target.bin', 3000)
    for i in range(120):
        os.link(os.path.join(m, 'many-links/target.bin'), os.path.join(m, f'many-links/name-{i:03d}-' + 'x' * 40 + '.bin'))
    # A symbolic link, the way ntfs-3g makes them (an Interix link: a system file, not a reparse point).
    os.symlink('docs', os.path.join(m, 'docs-link'))
    # A junction (mount-point reparse point) to C:\Windows, as Windows makes them.
    j = os.path.join(m, 'junction')
    os.makedirs(j)
    target = '\\??\\C:\\Windows'.encode('utf-16-le')
    shown = 'C:\\Windows'.encode('utf-16-le')
    names = target + b'\0\0' + shown + b'\0\0'
    body = struct.pack('<HHHH', 0, len(target), len(target) + 2, len(shown)) + names
    os.setxattr(j, 'system.ntfs_reparse_data', struct.pack('<IHH', 0xA0000003, len(body), 0) + body)
    # Enough files for the MFT to span several 1 MB chunks.
    for i in range(2500):
        write(m, f'many/d{i % 25}/f{i}.txt', i % 700)


def populate_fragmented(m):
    # Small clusters, and the MFT grows in pieces between data files: several MFT extents.
    for round_ in range(6):
        for i in range(600):
            write(m, f'r{round_}/f{i}.txt', 10)
        write(m, f'filler{round_}.bin', 600_000, bytes([round_ + 65]))
    write(m, 'deep/a/b/c/d.bin', 70_000)


def listing(m):
    out = []
    for dirpath, dirnames, filenames in os.walk(m):
        for name in dirnames + filenames:
            p = os.path.join(dirpath, name)
            st = os.lstat(p)
            # From NTFS's own attribute: a junction is a folder, even though it shows up as a link here.
            is_dir = bool(attrib(p) & 0x10)
            out.append({
                'path': os.path.relpath(p, m).replace(os.sep, '/'),
                'dir': is_dir,
                'size': 0 if is_dir else st.st_size,
                'attrib': attrib(p),
                'ino': st.st_ino,
                'nlink': st.st_nlink,
                'mtime': st.st_mtime,
                'link': os.path.islink(p),
            })
    out.sort(key=lambda e: e['path'])
    return out


def build(name, size_mb, cluster, populate, options='streams_interface=windows'):
    work = tempfile.mkdtemp(prefix='strata-ntfs-')
    img = os.path.join(work, f'{name}.img')
    mnt = os.path.join(work, 'mnt')
    os.makedirs(mnt)
    with open(img, 'wb') as f:
        f.truncate(size_mb * 1024 * 1024)
    run('mkntfs', '-F', '-q', '-f', '-c', str(cluster), '-L', name, img)
    run('ntfs-3g', '-o', options, img, mnt)
    try:
        populate(mnt)
        os.sync()
        entries = listing(mnt)
    finally:
        run('umount', mnt)
    os.makedirs(OUT, exist_ok=True)
    run('zstd', '-q', '-f', '-19', img, '-o', os.path.join(OUT, f'{name}.img.zst'))
    with open(os.path.join(OUT, f'{name}.json'), 'w', encoding='utf-8') as f:
        json.dump({'cluster': cluster, 'entries': entries}, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    shutil.rmtree(work)
    print(f'{name}: {len(entries)} entries, {os.path.getsize(os.path.join(OUT, name + ".img.zst")) // 1024} KB compressed')


if __name__ == '__main__':
    build('basic', 48, 4096, populate_basic, 'streams_interface=windows,compression')
    build('fragmented', 16, 512, populate_fragmented)
