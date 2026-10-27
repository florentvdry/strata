import release from '~/assets/release.json'

const repo = 'https://github.com/florentvdry/strata'

export const useStrata = () => ({
  repo,
  releases: `${repo}/releases/latest`,
  // Latest published version and its file URLs, generated from CHANGELOG.md (scripts/changelog.js site).
  release,
  // Detected on the client only, so the prerendered HTML stays identical for everyone.
  os: useState<'win' | 'linux' | null>('visitor-os', () => null),
})
