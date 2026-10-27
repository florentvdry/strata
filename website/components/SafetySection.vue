<template>
  <section id="safety" class="block">
    <div class="two">
      <div style="display:flex;flex-direction:column;gap:24px;min-width:0">
        <div class="head">
          <span class="kicker">Safety</span>
          <h2>It deletes files, so it's careful.</h2>
        </div>
        <ul class="checks">
          <li v-for="(c, i) in checks" :key="i">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--lime)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
            <span v-html="c" />
          </li>
        </ul>
      </div>

      <div id="source" style="display:flex;flex-direction:column;gap:24px;min-width:0">
        <div class="head">
          <span class="kicker">Build from source</span>
          <h2>Tauri app, Rust scanner.</h2>
          <p>Needs Node.js 20+, Git and Rust. See the README for platform toolchains.</p>
        </div>
        <pre><span class="p">$</span> git clone {{ repo }}.git
<span class="p">$</span> cd strata
<span class="p">$</span> npm install
<span class="p">$</span> npm start      <span class="c"># builds the scanner, runs the app</span>
<span class="p">$</span> npm run dist   <span class="c"># installer + portable .exe</span></pre>
        <div class="stack"><span v-for="s in stack" :key="s">{{ s }}</span></div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
const { repo } = useStrata()
// Static, trusted strings authored here.
const checks = [
  '<b>Nothing goes without a confirmation</b> listing every item and the space it frees.',
  '<b>Recycle Bin by default.</b> Permanent deletion is an explicit opt-in.',
  '<b>System locations are refused:</b> drive roots, Windows, Program Files, <code>/usr</code>, <code>/etc</code>, your home folder.',
  '<b>Caches are emptied, not removed.</b> Files in use are skipped and reported.',
  '<b>History</b> keeps 7 days and restores items to where they were.',
]
const stack = ['Rust scanner', 'NTFS MFT reader', 'Tauri', 'Preact', 'MIT']
</script>
