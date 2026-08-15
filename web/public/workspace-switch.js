(() => {
  'use strict'

  const SETTINGS_REFRESH_INTERVAL_MS = 1_000

  const script = document.currentScript
  const basePath = script instanceof HTMLScriptElement
    ? script.dataset.dshTrafficLightBase
    : undefined
  if (basePath === undefined) return

  const sessionRowSelector = '[role="treeitem"][class*="_sessionRow"]'
  const groupSectionSelector = '[class*="_groupSection"]'
  const state = {
    groups: [],
    flatSessions: [],
    busyIds: new Set(),
    activeMenuSessionId: undefined,
    locale: resolveLocale(),
    scheduled: false,
  }

  function resolveLocale(preference) {
    if (preference === 'zh' || preference === 'en') return preference
    const tags = [
      ...(Array.isArray(navigator.languages) ? navigator.languages : []),
      navigator.language,
    ]
    for (const tag of tags) {
      if (typeof tag !== 'string') continue
      const primary = tag.toLowerCase().split('-')[0]
      if (primary === 'zh' || primary === 'en') return primary
    }
    return 'zh'
  }

  function menuLabels() {
    if (state.locale === 'en') {
      return {
        enable: 'Enable Traffic Light',
        disable: 'Disable Traffic Light',
        enableAria: 'Enable floating traffic light',
        disableAria: 'Disable floating traffic light',
        enableTitle: 'Enable the floating traffic light for this session',
        disableTitle: 'Disable the floating traffic light for this session',
        error: 'Could not update the traffic light. Please try again.',
      }
    }
    return {
      enable: '开启红绿灯',
      disable: '关闭红绿灯',
      enableAria: '开启悬浮灯',
      disableAria: '关闭悬浮灯',
      enableTitle: '开启当前 Session 悬浮灯',
      disableTitle: '关闭当前 Session 悬浮灯',
      error: '红绿灯设置失败，请重试',
    }
  }

  function titleForProjectRow(row) {
    const title = row.querySelector('[class*="_projectText"] [class*="_title"]')
    return title instanceof HTMLElement ? title.innerText.trim() : ''
  }

  function groupQueues() {
    const queues = new Map()
    for (const group of state.groups) {
      const queue = queues.get(group.title) ?? []
      queue.push(group)
      queues.set(group.title, queue)
    }
    return queues
  }

  function syncRows() {
    const searchInput = document.querySelector('input[placeholder*="搜索"]')
    if (searchInput instanceof HTMLInputElement && searchInput.value.trim().length > 0) {
      removeAllButtons()
      return
    }

    const queues = groupQueues()
    const handledRows = new Set()
    for (const section of document.querySelectorAll(groupSectionSelector)) {
      if (!(section instanceof HTMLElement)) continue
      const projectRow = section.querySelector('[role="treeitem"][class*="_projectRow"]')
      const queue = projectRow instanceof HTMLElement ? queues.get(titleForProjectRow(projectRow)) : undefined
      const group = queue?.shift()
      const rows = section.querySelectorAll(sessionRowSelector)
      rows.forEach((row, index) => {
        if (!(row instanceof HTMLElement)) return
        handledRows.add(row)
        renderSessionRow(row, group?.sessions[index])
      })
    }

    // Flat mode has no group sections. It is a best-effort order match; the
    // normal grouped browser remains the authoritative mapping for duplicates.
    if (handledRows.size === 0) {
      document.querySelectorAll(sessionRowSelector).forEach((row, index) => {
        if (row instanceof HTMLElement) renderSessionRow(row, state.flatSessions[index])
      })
    }
  }

  function renderSessionRow(row, session) {
    const existing = row.querySelector(':scope > .dsh-traffic-toggle')
    existing?.remove()
    if (session === undefined || !session.visible) {
      delete row.dataset.dshTrafficSessionId
      return
    }
    row.dataset.dshTrafficSessionId = session.id
  }

  function removeAllButtons() {
    document.querySelectorAll('.dsh-traffic-toggle').forEach(button => button.remove())
  }

  function injectMenuItems() {
    const sessionId = state.activeMenuSessionId
    if (sessionId === undefined) return
    const session = allSessions().find(item => item.id === sessionId)
    if (session === undefined) return

    for (const menu of openSessionMenus()) {
      const existing = menu.querySelector('.dsh-traffic-menu-item')
      const item = existing instanceof HTMLElement ? existing : createMenuItem(menu)
      renderMenuItem(item, session)
    }
  }

  function openSessionMenus() {
    const candidates = document.querySelectorAll(
      '[role="menu"], [class*="_menuContent"], [class*="_menu"]',
    )
    return [...candidates].filter(element => (
      element instanceof HTMLElement
      && isVisible(element)
      && isSessionActionMenu(element)
    ))
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0
  }

  function isSessionActionMenu(element) {
    const text = element.textContent ?? ''
    return /重命名|分叉|归档|Rename|Branch|Archive/.test(text)
  }

  function createMenuItem(menu) {
    const template = [...menu.querySelectorAll('[role="menuitem"], button')]
      .find(element => !element.classList.contains('dsh-traffic-menu-item'))
    // Keep the official menu item's complete DOM/class structure.  DSH owns
    // its typography, spacing, hover state and corner radius; rebuilding the
    // contents from scratch makes the plugin item visibly drift from it.
    const item = template instanceof HTMLElement
      ? template.cloneNode(true)
      : document.createElement('button')
    if (!(template instanceof HTMLElement)) item.dataset.dshTrafficFallback = 'true'
    if (item instanceof HTMLButtonElement) item.type = 'button'
    item.classList.add('dsh-traffic-menu-item')
    item.setAttribute('role', 'menuitem')
    item.addEventListener('pointerdown', event => { event.stopPropagation() })
    item.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      const sessionId = item.dataset.sessionId
      if (sessionId !== undefined) void toggleSession(sessionId, item)
    })

    replaceTemplateIcon(item)
    setMenuLabel(item, '')
    menu.append(item)
    return item
  }

  function replaceTemplateIcon(item) {
    const original = item.querySelector('svg, img')
    const icon = createTrafficIcon(original instanceof SVGElement ? original : undefined)
    if (original instanceof Element) original.replaceWith(icon)
    else item.prepend(icon)
  }

  function createTrafficIcon(original) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('aria-hidden', 'true')
    if (original !== undefined) {
      for (const attribute of ['class', 'width', 'height', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']) {
        const value = original.getAttribute(attribute)
        if (value !== null) icon.setAttribute(attribute, value)
      }
    }
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '1.8')
    icon.setAttribute('stroke-linecap', 'round')
    icon.setAttribute('stroke-linejoin', 'round')

    const body = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    body.setAttribute('x', '5')
    body.setAttribute('y', '2.5')
    body.setAttribute('width', '14')
    body.setAttribute('height', '19')
    body.setAttribute('rx', '4')
    icon.append(body)
    for (const y of ['7', '12', '17']) {
      const lamp = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      lamp.setAttribute('cx', '12')
      lamp.setAttribute('cy', y)
      lamp.setAttribute('r', '1.25')
      lamp.setAttribute('fill', 'currentColor')
      lamp.setAttribute('stroke', 'none')
      icon.append(lamp)
    }
    return icon
  }

  function setMenuLabel(item, text) {
    const existing = item.querySelector('.dsh-traffic-menu-item__label')
    if (existing instanceof HTMLElement) {
      existing.textContent = text
      return
    }
    const candidates = [...item.querySelectorAll('*')]
      .filter(element => element.children.length === 0 && (element.textContent ?? '').trim().length > 0)
    const label = candidates.at(-1)
    if (label instanceof HTMLElement) {
      label.classList.add('dsh-traffic-menu-item__label')
      label.textContent = text
      return
    }
    item.append(document.createTextNode(text))
  }

  function renderMenuItem(item, session) {
    const busy = state.busyIds.has(session.id)
    const labels = menuLabels()
    item.dataset.sessionId = session.id
    item.dataset.enabled = String(session.enabled)
    if (item instanceof HTMLButtonElement) item.disabled = busy
    else item.setAttribute('aria-disabled', String(busy))
    item.setAttribute('aria-checked', String(session.enabled))
    item.setAttribute('aria-label', session.enabled ? labels.disableAria : labels.enableAria)
    item.title = session.enabled ? labels.disableTitle : labels.enableTitle
    setMenuLabel(item, session.enabled ? labels.disable : labels.enable)
  }

  async function toggleSession(sessionId, item) {
    const session = allSessions().find(candidate => candidate.id === sessionId)
    if (session === undefined || state.busyIds.has(session.id)) return

    state.busyIds.add(session.id)
    injectMenuItems()
    try {
      const response = await fetch(`${basePath}/api/sessions/toggle`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, enabled: !session.enabled }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      applySnapshot(await response.json())
    } catch (error) {
      item.dataset.error = 'true'
      item.title = menuLabels().error
      window.setTimeout(() => {
        delete item.dataset.error
        injectMenuItems()
      }, 2_000)
      console.warn('[dsh-traffic-light] Session toggle failed', error)
    } finally {
      state.busyIds.delete(session.id)
      injectMenuItems()
    }
  }

  function allSessions() {
    return [...state.groups.flatMap(group => group.sessions), ...state.flatSessions]
      .filter((session, index, list) => list.findIndex(item => item.id === session.id) === index)
  }

  function applySnapshot(snapshot) {
    state.groups = Array.isArray(snapshot.groups) ? snapshot.groups : []
    state.flatSessions = Array.isArray(snapshot.flatSessions) ? snapshot.flatSessions : []
    state.locale = resolveLocale(snapshot.localePreference)
    syncRows()
    injectMenuItems()
  }

  async function refresh() {
    try {
      const response = await fetch(`${basePath}/api/sessions`, {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      applySnapshot(await response.json())
    } catch (error) {
      console.warn('[dsh-traffic-light] Session settings unavailable', error)
    }
  }

  function scheduleSync() {
    if (state.scheduled) return
    state.scheduled = true
    window.setTimeout(() => {
      state.scheduled = false
      syncRows()
      injectMenuItems()
    }, 50)
  }

  const observer = new MutationObserver(scheduleSync)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : undefined
    const row = target?.closest(sessionRowSelector)
    if (row instanceof HTMLElement) {
      const sessionId = row.dataset.dshTrafficSessionId
      if (sessionId !== undefined) {
        state.activeMenuSessionId = sessionId
        window.setTimeout(injectMenuItems, 0)
      }
      return
    }

    // Do not let a Workspace menu reuse the last Session id. DSH renders both
    // menus in a portal, so the menu itself is not enough to identify which
    // row opened it; the row click is the authoritative Session context.
    state.activeMenuSessionId = undefined
  }, true)
  window.addEventListener('focus', () => { void refresh() })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh()
  })
  window.setInterval(() => { void refresh() }, SETTINGS_REFRESH_INTERVAL_MS)
  void refresh()
})()
