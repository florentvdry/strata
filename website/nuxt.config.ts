// Static site: `npm run generate` outputs .output/public.
// For GitHub Pages under /strata/, build with NUXT_APP_BASE_URL=/strata/.
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  app: {
    baseURL: process.env.NUXT_APP_BASE_URL || '/',
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Strata – See what fills your disk, then clean it up',
      meta: [
        { name: 'viewport', content: 'width=device-width,initial-scale=1,viewport-fit=cover' },
        { name: 'description', content: 'Strata maps every file on a drive as a block sized by its bytes, suggests safe cleanups and sends them to the Recycle Bin. Free, open source, for Windows and Linux.' },
        { name: 'theme-color', content: '#0E1014' },
        { property: 'og:title', content: 'Strata' },
        { property: 'og:description', content: 'See what fills your disk, then clean it up. A modern take on WinDirStat.' },
      ],
      link: [
        { rel: 'icon', type: 'image/png', href: '/favicon.png' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500&display=swap' },
      ],
    },
  },
})
