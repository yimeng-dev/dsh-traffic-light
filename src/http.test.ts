import { describe, expect, it } from 'vitest'
import { injectWorkspaceSwitch } from './http.js'

describe('injectWorkspaceSwitch', () => {
  it('injects same-origin workspace assets into the official DSH shell once', () => {
    const original = '<!doctype html><html><head><title>DSH</title></head><body></body></html>'
    const injected = injectWorkspaceSwitch(original, '/dsh-traffic-light')

    expect(injected).toContain('href="/dsh-traffic-light/workspace-switch.css"')
    expect(injected).toContain('src="/dsh-traffic-light/workspace-switch.js"')
    expect(injectWorkspaceSwitch(injected, '/dsh-traffic-light')).toBe(injected)
  })
})
