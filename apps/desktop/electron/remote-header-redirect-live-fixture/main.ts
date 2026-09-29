import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { app, BrowserWindow, net, session } from 'electron'

import {
  attachRemoteRequestHeaderListener,
  collectRemoteHeaderSources,
  resolveRemoteRequestHeaders
} from '../remote-ws-headers'

app.setPath('userData', join(process.argv[2], 'user-data'))
app.on('window-all-closed', () => {})

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function run(): Promise<void> {
  await app.whenReady()
  const seen: Record<string, IncomingHttpHeaders> = {}
  let sinkBase = ''

  const sink = createServer((request, response) => {
    seen[String(request.url)] = request.headers
    response.setHeader('content-type', request.url === '/fetch' ? 'application/json' : 'text/html')
    response.end(request.url === '/fetch' ? '{}' : '<!doctype html><p>ok</p>')
  })

  sinkBase = await listen(sink)

  const source = createServer((request, response) => {
    seen[String(request.url)] = request.headers

    const redirects = {
      '/gateway/same-start': '/gateway/same-final',
      '/gateway/net-start': `${sinkBase}/net`,
      '/gateway/window-start': `${sinkBase}/window`,
      '/gateway/fetch-start': `${sinkBase}/fetch`
    }

    const location = redirects[String(request.url)]

    if (location) {
      response.writeHead(302, { location }).end()

      return
    }

    response.setHeader('content-type', 'application/json')
    response.end('{}')
  })

  const sourceBase = await listen(source)

  const scopedHeaders = {
    Authorization: 'Bearer configured-secret',
    'X-Gateway-Secret': 'configured-secret'
  }

  const sources = collectRemoteHeaderSources({
    connections: [{ kind: 'remote', url: `${sourceBase}/gateway`, headers: scopedHeaders }]
  })

  const oauthSession = session.fromPartition('persist:remote-header-redirect-test')

  attachRemoteRequestHeaderListener(oauthSession, url => resolveRemoteRequestHeaders(url, { sources }))
  await oauthSession.cookies.set({
    url: `${sourceBase}/gateway`,
    name: 'hermes_session',
    value: 'cookie-secret'
  })

  const request = (pathname: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const clientRequest = net.request({
        url: `${sourceBase}${pathname}`,
        session: oauthSession,
        useSessionCookies: true,
        redirect: 'follow'
      })

      for (const [name, value] of Object.entries(scopedHeaders)) {
        clientRequest.setHeader(name, value)
      }

      clientRequest.on('response', response => {
        response.on('data', () => {})
        response.on('end', resolve)
      })
      clientRequest.on('error', reject)
      clientRequest.end()
    })

  try {
    await request('/gateway/same-start')
    assert.equal(seen['/gateway/same-final'].authorization, scopedHeaders.Authorization)
    assert.equal(seen['/gateway/same-final']['x-gateway-secret'], scopedHeaders['X-Gateway-Secret'])
    assert.match(String(seen['/gateway/same-final'].cookie), /hermes_session=cookie-secret/)

    await request('/gateway/net-start')
    assert.equal(seen['/net'].authorization, undefined)
    assert.equal(seen['/net']['x-gateway-secret'], undefined)

    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, session: oauthSession }
    })

    try {
      await win.loadURL(`${sourceBase}/gateway/window-start`, {
        extraHeaders: `Authorization: ${scopedHeaders.Authorization}\nX-Gateway-Secret: ${scopedHeaders['X-Gateway-Secret']}`
      })
      assert.equal(seen['/window'].authorization, undefined)
      assert.equal(seen['/window']['x-gateway-secret'], undefined)
    } finally {
      win.destroy()
    }

    const fetchResponse = await oauthSession.fetch(`${sourceBase}/gateway/fetch-start`, {
      credentials: 'include',
      headers: scopedHeaders
    })

    await fetchResponse.text()
    assert.equal(seen['/fetch'].authorization, undefined)
    assert.equal(seen['/fetch']['x-gateway-secret'], undefined)
    console.log('REMOTE_HEADER_REDIRECT_LIVE_OK')
  } finally {
    await Promise.all([close(source), close(sink)])
  }
}

void run().then(
  () => app.exit(0),
  error => {
    console.error(error)
    app.exit(1)
  }
)
