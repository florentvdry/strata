<template>
  <main id="top">
    <div class="wrap changelog">
      <div class="head">
        <span class="kicker">Changelog</span>
        <h1>What changed in each version.</h1>
        <p>
          Written for people, newest first. The same notes are in the app (Settings › Updates) and on each
          <a :href="`${repo}/releases`">GitHub release</a>.
          <a :href="`${base}changelog.xml`">RSS feed</a>
        </p>
        <label class="beta"><input v-model="beta" type="checkbox"> Show beta versions</label>
      </div>

      <article v-for="r in shown" :key="r.version" :id="`v${r.version}`" class="rel">
        <header>
          <h2><a :href="`#v${r.version}`">{{ r.version }}</a></h2>
          <span v-if="r.prerelease" class="tag">beta</span>
          <time :datetime="r.date">{{ r.date }}</time>
          <a class="dl" :href="`${repo}/releases/tag/v${r.version}`">Downloads</a>
        </header>
        <p v-if="r.summary" class="summary" v-html="inlineMd(r.summary)" />
        <section v-for="s in r.sections" :key="s.title">
          <h3>{{ s.title }}</h3>
          <ul>
            <li v-for="(it, i) in s.items" :key="i">
              <span v-html="inlineMd(it.text)" />
              <ul v-if="it.children.length">
                <li v-for="(c, j) in it.children" :key="j" v-html="inlineMd(c)" />
              </ul>
            </li>
          </ul>
        </section>
      </article>
    </div>
  </main>
</template>

<script setup lang="ts">
import changelog from '~/assets/changelog.json'

type Item = { text: string; children: string[] }
type Entry = { version: string; date: string; prerelease: boolean; summary: string; sections: { title: string; items: Item[] }[] }

const { repo } = useStrata()
const base = useRuntimeConfig().app.baseURL
const beta = ref(false)
const shown = computed(() => (changelog as Entry[]).filter((r) => beta.value || !r.prerelease))

useHead({ title: 'Changelog – Strata', link: [{ rel: 'alternate', type: 'application/rss+xml', title: 'Strata releases', href: `${base}changelog.xml` }] })
</script>
