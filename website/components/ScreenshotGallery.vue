<template>
  <section id="screens" class="block gal">
    <div class="head">
      <span class="kicker">Screenshots</span>
      <h2>Every screen, on a made-up drive.</h2>
    </div>
    <div class="tabs" role="tablist" aria-label="Screenshots">
      <button
        v-for="(s, i) in shots" :key="s.id" ref="tabEls" type="button" role="tab"
        :id="`tab-${s.id}`" :aria-selected="i === current" :tabindex="i === current ? 0 : -1"
        @click="current = i" @keydown="onKey($event, i)"
      >{{ s.label }}</button>
    </div>
    <figure class="shot" style="margin:0">
      <img :src="img(shots[current].id)" width="1600" :height="shots[current].h" :alt="shots[current].alt">
    </figure>
    <p class="gal-cap" aria-live="polite">{{ shots[current].cap }}</p>
    <!-- preload the rest so tab switches are instant -->
    <Head><Link v-for="s in shots.slice(1)" :key="s.id" rel="prefetch" as="image" :href="img(s.id)" /></Head>
  </section>
</template>

<script setup lang="ts">
const img = useImg()
const current = ref(0)
const tabEls = ref<HTMLElement[]>([])

const shots = [
  { id: 'start', label: 'Start', h: 1000, cap: 'Pick a drive or a folder, or drop one anywhere.', alt: 'Start screen with drive cards, scan options and recent scans' },
  { id: 'scanning', label: 'Scanning', h: 1000, cap: 'Live progress and a map that fills in as folders finish.', alt: 'Scanning screen with progress, live map and biggest files' },
  { id: 'explorer', label: 'Treemap', h: 1200, cap: 'Every block is a file, sized by bytes. Double-click to zoom in.', alt: 'Treemap of a drive with folder tree and details panel' },
  { id: 'sunburst', label: 'Sunburst', h: 1200, cap: 'Folder levels as rings.', alt: 'Sunburst view of the drive' },
  { id: 'columns', label: 'Columns', h: 1200, cap: 'Each column goes one folder deeper.', alt: 'Columns view of the drive' },
  { id: 'search', label: 'Search', h: 1200, cap: 'Matches light up on the map.', alt: 'Search results highlighted on the map' },
  { id: 'cleanup', label: 'Cleanup', h: 1000, cap: 'Review suggestions, then recycle or delete.', alt: 'Cleanup review with categories, safety badges and a summary' },
]

function onKey(e: KeyboardEvent, i: number) {
  const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
  if (!d) return
  current.value = (i + d + shots.length) % shots.length
  nextTick(() => tabEls.value[current.value]?.focus())
  e.preventDefault()
}
</script>
