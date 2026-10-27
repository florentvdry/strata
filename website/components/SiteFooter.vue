<template>
  <footer>
    <div class="wrap">
      <span>Strata · MIT license · by <a href="https://github.com/florentvdry">Florent Vandroy</a></span>
      <nav aria-label="Project links">
        <a :href="repo">GitHub</a>
        <a :href="`${repo}/releases`">Releases</a>
        <NuxtLink to="/changelog">Changelog</NuxtLink>
        <a :href="`${repo}/blob/main/docs/ARCHITECTURE.md`">Architecture</a>
        <a :href="`${repo}/blob/main/CONTRIBUTING.md`">Contributing</a>
      </nav>
    </div>
  </footer>
</template>

<script setup lang="ts">
const { repo } = useStrata()
</script>
