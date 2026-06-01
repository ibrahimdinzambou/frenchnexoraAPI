import { safeFetch } from '../utils/resolvers.js'

const BASE_URL = 'https://coflix.cymru'

export const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: `${BASE_URL}/`,
}

export const AJAX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/html, */*',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: `${BASE_URL}/`,
  'X-Requested-With': 'XMLHttpRequest',
}

function sleep(ms) {
  return new Promise(resolve => {
    const start = Date.now()
    function check() { if (Date.now() - start >= ms) resolve(); else Promise.resolve().then(check) }
    check()
  })
}

export async function fetchText(url, options = {}) {
  const retries = options.retries ?? 2
  const mergedHeaders = { ...HEADERS, ...(options.headers || {}) }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await safeFetch(url, { headers: mergedHeaders, timeout: options.timeout ?? 15000 })
      if (!res || !res.ok) {
        const status = res && typeof res.status === 'number' ? res.status : 'no-response'
        if (status === 404) return ''
        if (attempt < retries && status >= 500) {
          await sleep(1000 * (attempt + 1))
          continue
        }
        throw new Error(`HTTP error ${status}`)
      }
      return await res.text()
    } catch (e) {
      if (attempt >= retries) throw e
      await sleep(1000 * (attempt + 1))
    }
  }
  return ''
}

export async function fetchJson(url, options = {}) {
  const mergedHeaders = { ...AJAX_HEADERS, ...(options.headers || {}) }
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await safeFetch(url, { headers: mergedHeaders, timeout: options.timeout ?? 15000, ...options })
      if (!res) continue
      const text = await res.text()
      if (!text) return null
      try { return JSON.parse(text) } catch { return null }
    } catch (e) {
      if (attempt >= 2) return null
      await sleep(1000 * (attempt + 1))
    }
  }
  return null
}

export { BASE_URL }
