<template>
  <section id="download" class="block">
    <div class="head">
      <span class="kicker">Download</span>
      <h2>Get Strata.</h2>
      <p>All files are on the <a :href="releases">latest GitHub release</a>, with SHA-256 checksums.</p>
    </div>
    <div class="dl">
      <div id="os-win" class="os" :class="{ 'is-you': os === 'win' }" :style="{ order: os === 'win' ? -1 : 0 }">
        <div class="os-h">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="var(--blue)" aria-hidden="true"><path d="M3 5.5l7.5-1v7H3zM11.5 4.4L21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.4z" /></svg>
          <h3>Windows</h3>
          <span v-if="os === 'win'" class="you">Your system</span>
        </div>
        <p class="req">Windows 10 or 11, x64. No admin rights needed to install.</p>
        <div class="pkg">
          <a :href="releases">
            <span class="n">Installer</span><span class="arrow">↓ .exe</span>
            <span class="f">Strata-Setup-&lt;version&gt;.exe · Start menu shortcut, uninstall from Settings › Apps</span>
          </a>
          <a :href="releases">
            <span class="n">Portable</span><span class="arrow">↓ .exe</span>
            <span class="f">Strata-&lt;version&gt;-Portable.exe · one file, settings stored next to it</span>
          </a>
        </div>
        <div class="note"><span><b>SmartScreen warning?</b> The builds aren't code-signed yet. Click <i>More info</i> › <i>Run anyway</i>.</span></div>
      </div>

      <div id="os-linux" class="os" :class="{ 'is-you': os === 'linux' }" :style="{ order: os === 'linux' ? -1 : 0 }">
        <div class="os-h">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></svg>
          <h3>Linux</h3>
          <span v-if="os === 'linux'" class="you">Your system</span>
        </div>
        <p class="req">Common x64 distributions. Adds Strata to your app menu; run <code>strata</code> from a terminal.</p>
        <div class="pkg">
          <div v-for="p in packages" :key="p.f">
            <a class="n" :href="releases" style="color:var(--fg)">{{ p.n }}</a>
            <a class="arrow" :href="releases">↓ {{ p.ext }}</a>
            <span class="f">{{ p.f }}</span>
            <div class="cmd">
              <code>{{ p.c }}</code>
              <button type="button" class="copy" :aria-label="`Copy install command for ${p.n}`" @click="copy(p)">{{ copied === p.f ? 'Copied' : 'Copy' }}</button>
            </div>
          </div>
        </div>
        <div class="note tip"><span><b>Ubuntu 24.04+:</b> the AppImage and .tar.gz may stop at launch with a sandbox error. Use the .deb, or start with <code>--no-sandbox</code>. The AppImage also needs FUSE (<code>libfuse2t64</code>).</span></div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
const { releases, os } = useStrata()
const copied = ref('')

const packages = [
  { n: 'Ubuntu, Debian, Mint, Pop!_OS', f: 'Strata-<version>-amd64.deb', ext: '.deb', c: 'sudo apt install ./Strata-*-amd64.deb' },
  { n: 'Fedora, RHEL, Rocky, openSUSE', f: 'Strata-<version>-x86_64.rpm', ext: '.rpm', c: 'sudo dnf install ./Strata-*-x86_64.rpm' },
  { n: 'Arch, Manjaro, EndeavourOS', f: 'Strata-<version>-x64.pacman', ext: '.pacman', c: 'sudo pacman -U ./Strata-*-x64.pacman' },
  { n: 'Any distribution · AppImage', f: 'Strata-<version>-x86_64.AppImage', ext: '.AppImage', c: 'chmod +x Strata-*.AppImage && ./Strata-*.AppImage' },
  { n: 'Any distribution · no install', f: 'Strata-<version>-x64.tar.gz', ext: '.tar.gz', c: 'tar xzf Strata-*-x64.tar.gz && ./strata' },
]

async function copy(p: (typeof packages)[number]) {
  try {
    await navigator.clipboard.writeText(p.c)
    copied.value = p.f
    setTimeout(() => { copied.value = '' }, 1500)
  } catch { /* clipboard unavailable: the command stays selectable */ }
}

// Highlight the visitor's OS (client only, after hydration).
onMounted(() => {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const ua = nav.userAgentData?.platform || nav.platform || nav.userAgent || ''
  if (/win/i.test(ua)) os.value = 'win'
  else if (/linux|x11/i.test(ua) && !/android/i.test(nav.userAgent)) os.value = 'linux'
})
</script>
