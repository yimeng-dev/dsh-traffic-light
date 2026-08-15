import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { DashboardSnapshot } from './contracts.js'
import type { SessionSwitchSnapshot } from './session-settings.js'

type SnapshotProvider = () => DashboardSnapshot

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

export class SseHub {
  private readonly clients = new Set<ServerResponse>()

  constructor(private readonly snapshot: SnapshotProvider) {}

  handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      methodNotAllowed(res, 'GET')
      return
    }
    secureHeaders(res)
    res.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    })
    req.socket.setKeepAlive(true)
    this.clients.add(res)
    this.write(res, this.snapshot())
    req.once('close', () => { this.clients.delete(res) })
  }

  broadcast(snapshot: DashboardSnapshot): void {
    for (const client of this.clients) this.write(client, snapshot)
  }

  ping(): void {
    for (const client of this.clients) client.write(': keepalive\n\n')
  }

  close(): void {
    for (const client of this.clients) client.end()
    this.clients.clear()
  }

  private write(res: ServerResponse, snapshot: DashboardSnapshot): void {
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
  }
}

export interface RouteOptions {
  basePath: string
  webRoot: string
  webServer: WebServer
  snapshot: SnapshotProvider
  reset: () => DashboardSnapshot
  sessions: () => Promise<SessionSwitchSnapshot>
  toggleSession: (sessionId: string, enabled: boolean) => Promise<SessionSwitchSnapshot>
  sse: SseHub
}

export function registerRoutes(options: RouteOptions): () => void {
  const {
    basePath,
    webRoot,
    webServer,
    snapshot,
    reset,
    sessions,
    toggleSession,
    sse,
  } = options
  const disposers = [
    webServer.tapIndex(html => injectWorkspaceSwitch(html, basePath)),
    webServer.register({
      kind: 'exact',
      path: `${basePath}/api/state`,
      handler: (req, res) => {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
        sendJson(res, 200, snapshot())
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${basePath}/api/events`,
      handler: (req, res) => { sse.handle(req, res) },
    }),
    webServer.register({
      kind: 'exact',
      path: `${basePath}/api/reset`,
      handler: (req, res) => {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
        sendJson(res, 200, reset())
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${basePath}/api/sessions`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
        try {
          sendJson(res, 200, await sessions())
        } catch (error) {
          sendJson(res, 500, { error: messageForError(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${basePath}/api/sessions/toggle`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
        if (!hasSameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request denied' })
        try {
          const input = await readToggleInput(req)
          sendJson(res, 200, await toggleSession(input.sessionId, input.enabled))
        } catch (error) {
          const status = error instanceof RequestError ? error.status : 500
          sendJson(res, status, { error: messageForError(error) })
        }
      },
    }),
    webServer.register({
      kind: 'prefix',
      path: basePath,
      handler: (req, res) => serveStatic(req, res, basePath, webRoot),
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

export function injectWorkspaceSwitch(html: string, basePath: string): string {
  if (html.includes('data-dsh-traffic-light-base=')) return html
  const tags = [
    `<link rel="stylesheet" href="${basePath}/workspace-switch.css" data-dsh-traffic-light-base="${basePath}">`,
    `<script defer src="${basePath}/workspace-switch.js" data-dsh-traffic-light-base="${basePath}"></script>`,
  ].join('')
  return html.includes('</head>') ? html.replace('</head>', `${tags}</head>`) : `${tags}${html}`
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  basePath: string,
  webRoot: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res, 'GET, HEAD')
    return
  }

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (pathname === basePath) {
    res.writeHead(308, { Location: `${basePath}/` })
    res.end()
    return
  }

  let relativePath: string
  try {
    relativePath = decodeURIComponent(pathname.slice(basePath.length + 1))
  } catch {
    sendText(res, 400, 'Malformed path')
    return
  }
  if (relativePath.length === 0) relativePath = 'index.html'

  const root = resolve(webRoot)
  const filePath = resolve(root, relativePath)
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    sendText(res, 403, 'Forbidden')
    return
  }

  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('not a file')
    const body = await readFile(filePath)
    secureHeaders(res)
    const dynamicAsset = relativePath === 'index.html'
      || relativePath === 'workspace-switch.js'
      || relativePath === 'workspace-switch.css'
    res.writeHead(200, {
      'Cache-Control': dynamicAsset ? 'no-cache' : 'public, max-age=31536000, immutable',
      'Content-Length': String(body.byteLength),
      'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  } catch {
    sendText(res, 404, 'Not found')
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  secureHeaders(res)
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string): void {
  secureHeaders(res)
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'text/plain; charset=utf-8',
  })
  res.end(body)
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow)
  sendText(res, 405, 'Method not allowed')
}

function secureHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function readToggleInput(req: IncomingMessage): Promise<{ sessionId: string; enabled: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > 4_096) throw new RequestError(413, 'Request body is too large')
    chunks.push(buffer)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new RequestError(400, 'Malformed JSON body')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new RequestError(400, 'Request body must be an object')
  }
  const input = parsed as { sessionId?: unknown; enabled?: unknown }
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
    throw new RequestError(400, 'sessionId must be a non-empty string')
  }
  if (typeof input.enabled !== 'boolean') {
    throw new RequestError(400, 'enabled must be a boolean')
  }
  return { sessionId: input.sessionId, enabled: input.enabled }
}

function hasSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
