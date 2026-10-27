<template>
  <section id="download" class="block">
    <div class="head">
      <span class="kicker">Download</span>
      <h2>Get Strata.</h2>
      <p>
        Version <b>{{ release.version }}</b> · {{ release.date }} ·
        <a :href="release.url">release notes</a> · <NuxtLink to="/changelog">changelog</NuxtLink>.
        All files are on the <a :href="releases">latest GitHub release</a><template v-if="release.files.checksums">, with <a :href="release.files.checksums">SHA-256 checksums</a></template>.
      </p>
    </div>
    <div class="dl">
      <div id="os-win" class="os" :class="{ 'is-you': os === 'win' }" :style="{ order: os === 'win' ? -1 : 0 }">
        <div class="os-h">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="var(--blue)" aria-hidden="true"><path d="M3 5.5l7.5-1v7H3zM11.5 4.4L21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.4z" /></svg>
          <h3>Windows</h3>
          <span v-if="os === 'win'" class="you">Your system</span>
        </div>
        <p class="req">Windows 10 or 11, x64. No admin rights needed to install. Uses the WebView2 runtime that comes with Windows (the installer adds it if missing).</p>
        <div class="pkg">
          <a :href="release.files.setup">
            <span class="n">Installer</span><span class="arrow">↓ .exe</span>
            <span class="f">Strata-Setup-{{ release.version }}.exe · Start menu shortcut, uninstall from Settings › Apps</span>
          </a>
          <a :href="release.files.portable">
            <span class="n">Portable</span><span class="arrow">↓ .exe</span>
            <span class="f">Strata-{{ release.version }}-Portable.exe · one file, settings stored next to it</span>
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
        <p class="req">Common x64 distributions with WebKitGTK 4.1 (Ubuntu 22.04+, Debian 12+, Fedora, Arch). Adds Strata to your app menu; run <code>strata</code> from a terminal.</p>
        <div class="pkg">
          <div v-for="p in packages" :key="p.f">
            <a class="n" :href="link(p)" style="color:var(--fg)">{{ p.n }}</a>
            <a class="arrow" :href="link(p)">↓ {{ p.ext }}</a>
            <span class="f">{{ p.f.replace('<version>', release.version) }}</span>
            <div class="cmd">
              <code>{{ p.c }}</code>
              <button type="button" class="copy" :aria-label="`Copy install command for ${p.n}`" @click="copy(p)">{{ copied === p.f ? 'Copied' : 'Copy' }}</button>
            </div>
          </div>
        </div>
        <div class="note tip"><span><b>AppImage:</b> needs FUSE (<code>libfuse2t64</code> on Ubuntu 24.04+). The .deb and .rpm update from inside Strata too, after asking for your password.</span></div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
const { releases, release, os } = useStrata()
const copied = ref('')

const packages = [
  { n: 'Ubuntu, Debian, Mint, Pop!_OS', k: 'deb', f: 'Strata-<version>-amd64.deb', ext: '.deb', c: 'sudo apt install ./Strata-*-amd64.deb' },
  { n: 'Fedora, RHEL, Rocky, openSUSE', k: 'rpm', f: 'Strata-<version>-x86_64.rpm', ext: '.rpm', c: 'sudo dnf install ./Strata-*-x86_64.rpm' },
  { n: 'Arch, Manjaro, EndeavourOS', k: 'pacman', f: 'Strata-<version>-x64.pacman', ext: '.pacman', c: 'sudo pacman -U ./Strata-*-x64.pacman' },
  { n: 'Any distribution · AppImage', k: 'appimage', f: 'Strata-<version>-x86_64.AppImage', ext: '.AppImage', c: 'chmod +x Strata-*.AppImage && ./Strata-*.AppImage' },
  { n: 'Any distribution · no install', k: 'tar', f: 'Strata-<version>-x64.tar.gz', ext: '.tar.gz', c: 'tar xzf Strata-*-x64.tar.gz && ./strata' },
]

// Direct link when the latest release has the file, the release page otherwise.
const link = (p: (typeof packages)[number]) => (release.files as Record<string, string>)[p.k] || releases

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
