<template>
  <main id="top">
      <div class="wrap">
        <HeroSection />
        <FeaturesSection />
        <ScreenshotGallery />
        <DownloadSection />
        <SafetySection />
        <section class="final">
          <h2>Find out where your space went.</h2>
          <div class="cta">
            <a class="btn btn-primary" href="#download">Download Strata</a>
            <a class="btn btn-ghost" :href="`${repo}/issues`">Report an issue</a>
          </div>
        </section>
      </div>
    </main>
</template>

<script setup lang="ts">
const { repo } = useStrata()
</script>
