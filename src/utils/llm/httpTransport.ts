/*
 * Codex endpoints block direct fetch with CORS, so we use Node's http/https on
 * desktop. Obsidian's requestUrl can bypass CORS but does not support streaming
 * today; Codex requires stream: true, so a non-streaming fallback needs more
 * work and is not worth it for now. To cooperate with proxy setups, we resolve
 * session proxy rules from Electron when available and translate them into Node
 * proxy agents. Mobile has no Node APIs, so Node modules are loaded at runtime
 * only when running on desktop.
 */

import { Platform } from 'obsidian'

export type StreamSource = ReadableStream<Uint8Array> | NodeJS.ReadableStream
type NodeLikeIncomingMessage = NodeJS.ReadableStream & {
  statusCode?: number
}
type RequestAgent = import('http').Agent

type PostOptions = {
  headers?: Record<string, string>
  signal?: AbortSignal
  fetchFn?: typeof fetch
}

export async function postJson<T>(
  endpoint: string,
  body: unknown,
  options: PostOptions = {},
): Promise<T> {
  const { headers, signal, fetchFn } = options
  const payload = JSON.stringify(body)

  if (fetchFn) {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(headers ?? {}),
      },
      body: payload,
      signal,
    })

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`)
    }

    return (await response.json()) as T
  }

  const response = await nodePost(endpoint, payload, headers, signal)
  const status = response.statusCode ?? 0
  const responseBody = await readStreamToString(response)
  if (status < 200 || status >= 300) {
    throw new Error(`Request failed: ${status} ${responseBody}`)
  }

  return JSON.parse(responseBody) as T
}

export async function postFormUrlEncoded<T>(
  endpoint: string,
  body: Record<string, string>,
  options: PostOptions = {},
): Promise<T> {
  const { headers, signal, fetchFn } = options
  const payload = new URLSearchParams(body).toString()
  const formHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...(headers ?? {}),
  }

  if (fetchFn) {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: formHeaders,
      body: payload,
      signal,
    })

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`)
    }

    return (await response.json()) as T
  }

  const response = await nodePost(
    endpoint,
    payload,
    formHeaders,
    signal,
    'application/x-www-form-urlencoded',
  )
  const status = response.statusCode ?? 0
  const responseBody = await readStreamToString(response)
  if (status < 200 || status >= 300) {
    throw new Error(`Request failed: ${status} ${responseBody}`)
  }

  return JSON.parse(responseBody) as T
}

export async function postStream(
  endpoint: string,
  body: unknown,
  options: PostOptions = {},
): Promise<StreamSource> {
  const { headers, signal, fetchFn } = options
  const payload = JSON.stringify(body)

  if (fetchFn) {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(headers ?? {}),
      },
      body: payload,
      signal,
    })

    if (!response.ok || !response.body) {
      throw new Error(`Request failed: ${response.status}`)
    }

    return response.body
  }

  const response = await nodePost(endpoint, payload, headers, signal)
  const status = response.statusCode ?? 0
  if (status < 200 || status >= 300) {
    const responseBody = await readStreamToString(response)
    throw new Error(`Request failed: ${status} ${responseBody}`)
  }

  return response
}

async function nodePost(
  endpoint: string,
  body: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  contentType = 'application/json',
): Promise<NodeLikeIncomingMessage> {
  if (!Platform.isDesktop) {
    throw new Error('HTTP transport is not available on mobile')
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http') as typeof import('http')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('https') as typeof import('https')
  const url = new URL(endpoint)
  const client = url.protocol === 'https:' ? https : http
  const agent = await getProxyAgent(endpoint)
  const payloadLength = Buffer.byteLength(body)
  const requestHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': payloadLength.toString(),
    ...(headers ?? {}),
  }
  const requestOptions: import('http').RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    path: `${url.pathname}${url.search}`,
    method: 'POST',
    headers: requestHeaders,
    ...(agent ? { agent } : {}),
  }

  return new Promise((resolve, reject) => {
    const request = client.request(requestOptions, (response) => {
      resolve(response)
    })

    let settled = false
    const rejectOnce = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    }

    request.on('error', (error) => {
      rejectOnce(error)
    })

    if (signal) {
      const abortError = new Error('Request aborted')
      if (signal.aborted) {
        rejectOnce(abortError)
        request.destroy(abortError)
        return
      }
      const abortHandler = () => {
        rejectOnce(abortError)
        request.destroy(abortError)
      }
      signal.addEventListener('abort', abortHandler, { once: true })
      request.on('close', () => {
        signal.removeEventListener('abort', abortHandler)
      })
    }

    request.write(body)
    request.end()
  })
}

async function getProxyAgent(
  endpoint: string,
): Promise<RequestAgent | undefined> {
  const proxyUrl =
    (await getElectronSessionProxyUrl(endpoint)) ?? getEnvProxyUrl(endpoint)
  if (!proxyUrl) {
    return undefined
  }

  const endpointProtocol = new URL(endpoint).protocol
  if (proxyUrl.startsWith('socks')) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SocksProxyAgent } = require('socks-proxy-agent') as {
      SocksProxyAgent: new (proxy: string) => RequestAgent
    }
    return new SocksProxyAgent(proxyUrl)
  }

  if (endpointProtocol === 'https:') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HttpsProxyAgent } = require('https-proxy-agent') as {
      HttpsProxyAgent: new (proxy: string) => RequestAgent
    }
    return new HttpsProxyAgent(proxyUrl)
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { HttpProxyAgent } = require('http-proxy-agent') as {
    HttpProxyAgent: new (proxy: string) => RequestAgent
  }
  return new HttpProxyAgent(proxyUrl)
}

async function getElectronSessionProxyUrl(
  endpoint: string,
): Promise<string | undefined> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as {
      session?: {
        defaultSession?: {
          resolveProxy?: (url: string) => Promise<string>
        }
      }
      remote?: {
        session?: {
          defaultSession?: {
            resolveProxy?: (url: string) => Promise<string>
          }
        }
      }
    }

    const defaultSession =
      electron.session?.defaultSession ??
      electron.remote?.session?.defaultSession
    const proxyRules = await defaultSession?.resolveProxy?.(endpoint)
    return proxyRules ? normalizeProxyRules(proxyRules) : undefined
  } catch {
    return undefined
  }
}

function getEnvProxyUrl(endpoint: string): string | undefined {
  const protocol = new URL(endpoint).protocol
  const env = process.env
  if (protocol === 'https:') {
    return (
      env.HTTPS_PROXY ??
      env.https_proxy ??
      env.HTTP_PROXY ??
      env.http_proxy ??
      env.ALL_PROXY ??
      env.all_proxy
    )
  }

  return env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy
}

function normalizeProxyRules(proxyRules: string): string | undefined {
  for (const rawRule of proxyRules.split(';')) {
    const rule = rawRule.trim()
    if (!rule || rule === 'DIRECT') {
      continue
    }

    const [scheme, hostPort] = rule.split(/\s+/, 2)
    if (!scheme || !hostPort) {
      continue
    }

    switch (scheme.toUpperCase()) {
      case 'PROXY':
        return `http://${hostPort}`
      case 'HTTPS':
        return `https://${hostPort}`
      case 'SOCKS':
        return `socks://${hostPort}`
      case 'SOCKS4':
        return `socks4://${hostPort}`
      case 'SOCKS5':
        return `socks5://${hostPort}`
    }
  }

  return undefined
}

async function readStreamToString(
  stream: NodeJS.ReadableStream,
): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk))
    } else {
      chunks.push(chunk as Uint8Array)
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}
