#!/usr/bin/env python3
"""Seeds the fuzz corpora with real data from the NTFS test images: MFT records for mft_record, a small volume for
mft_volume. Run from scanner/: python3 fuzz/seed-corpus.py"""
import os
import struct
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
img = subprocess.run(['zstd', '-d', '-c', os.path.join(HERE, '..', 'tests', 'fixtures', 'basic.img.zst')],
                     check=True, capture_output=True).stdout
sector = struct.unpack('<H', img[0x0B:0x0D])[0]
mft = struct.unpack('<q', img[0x30:0x38])[0] * img[0x0D] * sector
out = os.path.join(HERE, 'corpus', 'mft_record')
os.makedirs(out, exist_ok=True)
for k in range(0, 160, 16):
    with open(os.path.join(out, f'seed{k}'), 'wb') as f:
        f.write(img[mft + k * 1024:mft + (k + 16) * 1024])
print(f'seeded {out}')
