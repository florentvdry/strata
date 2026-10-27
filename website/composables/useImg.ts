// Resolves /public/img/<name>.webp against the configured base URL.
export const useImg = () => {
  const base = useRuntimeConfig().app.baseURL
  return (name: string) => `${base}img/${name}.webp`
}
