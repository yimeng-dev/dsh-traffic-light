import { copyFile } from 'node:fs/promises'

await copyFile(
  new URL('../desktop/preload.cjs', import.meta.url),
  new URL('../dist/desktop/preload.cjs', import.meta.url),
)
