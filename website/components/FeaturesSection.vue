<template>
  <section id="features" class="block">
    <div class="head">
      <span class="kicker">Features</span>
      <h2>From a full drive to free space in four steps.</h2>
    </div>
    <div class="feat">
      <article v-for="g in groups" :key="g.title">
        <span class="sw" :style="{ background: g.color }" />
        <h3>{{ g.title }}</h3>
        <ul>
          <li v-for="(item, i) in g.items" :key="i" v-html="item" />
        </ul>
      </article>
    </div>
    <div class="syntax" aria-label="Search examples">
      <div v-for="s in syntax" :key="s.q"><code>{{ s.q }}</code><span>{{ s.d }}</span></div>
    </div>
  </section>
</template>

<script setup lang="ts">
// Items are static, trusted strings authored here (they contain <b> markup).
const groups = [
  { title: 'Scan', color: 'var(--lime)', items: [
    '<b>Fast scan</b> reads the NTFS master file table directly, typically 10–20× faster than walking folders.',
    'Multi-threaded walk everywhere else: ext4, Btrfs, XFS, ZFS, exFAT, network shares.',
    'Live progress with pause, resume and partial results.',
  ] },
  { title: 'Map', color: 'var(--blue)', items: [
    'Cushion-shaded <b>treemap</b>, <b>sunburst</b> and <b>columns</b> views of the same data.',
    'Folder tree sorted by size, kept in sync with the map.',
    'A file-type legend that lights up a type on the map.',
  ] },
  { title: 'Find', color: 'var(--amber)', items: [
    '<b>Search</b> by name, glob, size and type.',
    '<b>Smart views:</b> largest files, duplicates verified by content, untouched for a year, caches, dev artifacts.',
  ] },
  { title: 'Clean up', color: 'var(--pink)', items: [
    'Suggestions with reasons, each marked <b>Safe</b> or <b>Review</b>.',
    'Recycle Bin (or Trash) by default, system folders refused.',
    'A 7-day <b>History</b> restores what you removed.',
  ] },
]
const syntax = [
  { q: '*.mkv >1 GB', d: 'Videos over a gigabyte' },
  { q: 'type:archive', d: 'Zips, ISOs and disk images' },
  { q: 'backup <500MB', d: 'Small files named “backup”' },
  { q: '*.iso >=2gb', d: 'Terms combine freely' },
]
</script>
