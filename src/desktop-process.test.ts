import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DesktopProcessController,
  prepareElectronRuntime,
  resolveDesktopExecutable,
} from './desktop-process.js'

describe('resolveDesktopExecutable', () => {
  it('keeps an explicitly configured executable unchanged', () => {
    expect(resolveDesktopExecutable('/custom/Electron', '/project')).toBe('/custom/Electron')
  })

  it('uses the Electron package entry to obtain the runtime path', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-traffic-light-electron-'))
    const electronRoot = join(projectRoot, 'node_modules', 'electron')
    const executable = join(projectRoot, 'runtime', 'Electron')

    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'electron-resolution-fixture',
      private: true,
      type: 'module',
    }))
    await mkdir(electronRoot, { recursive: true })
    await writeFile(join(electronRoot, 'package.json'), JSON.stringify({
      name: 'electron',
      main: 'index.cjs',
      type: 'commonjs',
    }))
    await writeFile(
      join(electronRoot, 'index.cjs'),
      `module.exports = ${JSON.stringify(executable)}\n`,
    )

    expect(resolveDesktopExecutable('', projectRoot)).toBe(executable)
  })

  it('runs the Electron installer in a separate Node process', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-traffic-light-installer-'))
    const electronRoot = join(projectRoot, 'node_modules', 'electron')
    const marker = join(electronRoot, 'prepared')

    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'electron-installer-fixture',
      private: true,
      type: 'module',
    }))
    await mkdir(electronRoot, { recursive: true })
    await writeFile(join(electronRoot, 'package.json'), JSON.stringify({ name: 'electron' }))
    await writeFile(
      join(electronRoot, 'install.js'),
      "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'prepared'), 'ready')\n",
    )

    await prepareElectronRuntime(projectRoot)
    await expect(readFile(marker, 'utf8')).resolves.toBe('ready')
  })

  it('stops a background installer when its owner is disposed', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-traffic-light-abort-'))
    const electronRoot = join(projectRoot, 'node_modules', 'electron')
    const abort = new AbortController()

    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'electron-abort-fixture',
      private: true,
      type: 'module',
    }))
    await mkdir(electronRoot, { recursive: true })
    await writeFile(join(electronRoot, 'package.json'), JSON.stringify({ name: 'electron' }))
    await writeFile(join(electronRoot, 'install.js'), 'setTimeout(() => {}, 5_000)\n')

    const preparation = prepareElectronRuntime(projectRoot, abort.signal)
    abort.abort()
    await expect(preparation).rejects.toThrow('cancelled')
  })

  it('does not continue to resolve or launch after disposal during prewarm', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-traffic-light-controller-'))
    const electronRoot = join(projectRoot, 'node_modules', 'electron')
    const warnings: string[] = []

    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'electron-controller-fixture',
      private: true,
      type: 'module',
    }))
    await mkdir(electronRoot, { recursive: true })
    await writeFile(join(electronRoot, 'package.json'), JSON.stringify({
      name: 'electron',
      main: 'index.cjs',
      type: 'commonjs',
    }))
    await writeFile(join(electronRoot, 'install.js'), 'setTimeout(() => {}, 5_000)\n')
    await writeFile(join(electronRoot, 'index.cjs'), "throw new Error('must not resolve after dispose')\n")

    const controller = new DesktopProcessController(
      projectRoot,
      join(projectRoot, 'state.json'),
      join(projectRoot, 'settings.json'),
      '',
      { warn: message => { warnings.push(message) } },
    )
    const startup = controller.setDesiredRunning(true)
    controller.dispose()

    await startup
    expect(warnings).toEqual([])
  })
})
