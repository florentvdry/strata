const repo = 'https://github.com/florentvdry/strata'

export const useStrata = () => ({
  repo,
  releases: `${repo}/releases/latest`,
  // Detected on the client only, so the prerendered HTML stays identical for everyone.
  os: useState<'win' | 'linux' | null>('visitor-os', () => null),
})
