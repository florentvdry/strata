<template>
  <section class="hero">
    <span class="eyebrow"><i /> Free &amp; open source · Windows 10/11 · Linux</span>
    <h1>See what fills your disk, then <em>clean it up.</em></h1>
    <p class="lede">Strata maps every file on a drive as a block sized by its bytes. Spot the 48 GB recording you forgot about, review cleanup suggestions with reasons, and send them to the Recycle Bin. A modern take on WinDirStat.</p>
    <div class="cta">
      <a class="btn btn-primary" :href="os ? `#os-${os}` : '#download'">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></svg>
        <span>{{ os === 'win' ? 'Download for Windows' : os === 'linux' ? 'Download for Linux' : 'Download Strata' }}</span>
      </a>
      <a class="btn btn-ghost" :href="repo">View source</a>
    </div>
    <div class="meta"><span>MIT license</span><span>No account</span><span>No telemetry</span><span>Works offline</span></div>
  </section>

  <figure class="shot" style="margin:0">
    <img :src="img('explorer')" width="1600" height="1200" alt="Strata's explorer: a treemap of a drive, the folder tree, file types and the selected file's details">
  </figure>
  <div class="strata-bar" aria-hidden="true">
    <span v-for="b in bar" :key="b.c" :style="{ flex: b.f, background: b.c }" />
  </div>
</template>

<script setup lang="ts">
const { repo, os } = useStrata()
const img = useImg()
const bar = [
  { f: 36, c: 'var(--pink)' }, { f: 27, c: 'var(--blue)' }, { f: 11, c: '#5B6576' }, { f: 11, c: 'var(--violet)' },
  { f: 6, c: 'var(--amber)' }, { f: 4, c: '#34D399' }, { f: 3, c: '#22C3D8' }, { f: 2, c: '#E9D27A' },
]
</script>
