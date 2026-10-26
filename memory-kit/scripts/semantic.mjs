/**
 * memory-kit · optional semantic layer (embeddings + rerank)
 * ============================================================================
 * Keyword retrieval stays the default and the fallback. This module adds an
 * OpenAI-compatible semantic path on top of it:
 *
 *   reindex --vectors   build/refresh `memory/.index.vectors.json`
 *   search --semantic   cosine top-N, then rerank, then the usual rendering
 *
 * Configuration (env wins, then files):
 *   MEMORY_API_KEY      or  <root>/scripts/.mem_api_key  or  ~/.mem_api_key
 *   MEMORY_BASE_URL     default https://api.siliconflow.cn/v1
 *   MEMORY_EMBED_MODEL  default BAAI/bge-m3
 *   MEMORY_RERANK_MODEL default BAAI/bge-reranker-v2-m3
 *
 * Every failure (no key, no network, HTTP error, bad payload) throws a typed
 * error so the caller can fall back to keyword search — never break a round.
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const VECTORS_FILE = '.index.vectors.json'
export const RERANK_TOP = 20
const EMBED_BATCH = 16

export class SemanticUnavailable extends Error {
  constructor(message, code = 'SEMANTIC_UNAVAILABLE') {
    super(message)
    this.code = code
  }
}

const readKeyFile = (p) => {
  try { return readFileSync(p, 'utf8').trim() } catch { return '' }
}

/** Resolve provider settings; never returns the key itself in logs. */
export function semanticConfig(root, env = process.env) {
  // MEMORY_HOME exists so tests (and sandboxed runs) can point at an isolated home
  const home = String(env.MEMORY_HOME || '').trim() || homedir()
  const key = String(env.MEMORY_API_KEY || '').trim()
    || readKeyFile(join(root, 'scripts', '.mem_api_key'))
    || readKeyFile(join(home, '.mem_api_key'))
  return {
    key,
    baseUrl: String(env.MEMORY_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, ''),
    embedModel: String(env.MEMORY_EMBED_MODEL || 'BAAI/bge-m3'),
    rerankModel: String(env.MEMORY_RERANK_MODEL || 'BAAI/bge-reranker-v2-m3'),
    timeoutMs: Number(env.MEMORY_API_TIMEOUT_MS || 30000) || 30000,
  }
}

export const hasApiKey = (cfg) => Boolean(cfg && cfg.key)

async function postJson(cfg, path, payload) {
  if (!cfg.key) throw new SemanticUnavailable('未配置 API key（MEMORY_API_KEY 或 ~/.mem_api_key）', 'NO_KEY')
  let res
  try {
    res = await fetch(cfg.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
  } catch (e) {
    throw new SemanticUnavailable('请求失败：' + String(e?.message ?? e), 'NETWORK')
  }
  if (!res.ok) throw new SemanticUnavailable(`HTTP ${res.status} ${path}`, 'HTTP_' + res.status)
  try {
    return await res.json()
  } catch (e) {
    throw new SemanticUnavailable('响应不是合法 JSON：' + String(e?.message ?? e), 'BAD_JSON')
  }
}

export const vectorCachePath = (root) => join(root, 'memory', VECTORS_FILE)
export const shaOf = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 32)

/** Batch-embed texts through the provider. */
export async function embedTexts(cfg, texts) {
  const out = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH)
    const json = await postJson(cfg, '/embeddings', { model: cfg.embedModel, input: batch })
    const rows = Array.isArray(json?.data) ? json.data : []
    if (rows.length !== batch.length) throw new SemanticUnavailable('嵌入返回条数不对', 'BAD_PAYLOAD')
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    for (const row of rows) {
      if (!Array.isArray(row.embedding)) throw new SemanticUnavailable('嵌入没有向量', 'BAD_PAYLOAD')
      out.push(row.embedding)
    }
  }
  return out
}

/** Rerank candidate texts; returns [{index, score}] best-first. */
export async function rerankDocs(cfg, query, docs, topN = RERANK_TOP) {
  if (!docs.length) return []
  const json = await postJson(cfg, '/rerank', {
    model: cfg.rerankModel,
    query,
    documents: docs.map((d) => String(d).slice(0, 2000)),
    top_n: Math.max(1, Math.min(topN, docs.length)),
  })
  const rows = Array.isArray(json?.results) ? json.results
    : Array.isArray(json?.data) ? json.data : []
  if (!rows.length) throw new SemanticUnavailable('重排返回为空', 'BAD_PAYLOAD')
  return rows
    .map((r) => ({ index: Number(r.index ?? 0), score: Number(r.relevance_score ?? r.score ?? 0) }))
    .filter((r) => Number.isFinite(r.index) && r.index >= 0 && r.index < docs.length)
    .sort((a, b) => b.score - a.score)
}

const norm = (v) => {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}
export const cosine = (a, b) => {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

export function loadVectorCache(root) {
  const p = vectorCachePath(root)
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (j && j.items && typeof j.items === 'object') return j
  } catch { /* missing or broken cache — rebuild */ }
  return { at: '', model: '', items: {} }
}

export function saveVectorCache(root, cache) {
  const p = vectorCachePath(root)
  try { writeFileSync(p, JSON.stringify(cache), 'utf8') } catch { /* read-only dir */ }
}

/** Text used for embedding a document: title + summary + scope + body head. */
export function embedTextOf(doc) {
  const head = `# ${doc.title || ''}\n${doc.meta.summary || ''}\n${doc.meta.scope || ''}`
  return (head + '\n' + String(doc.body || '').slice(0, 4000)).slice(0, 6000)
}

/**
 * Build/refresh the vector cache for the given docs.
 * @returns {Promise<{embedded:number, reused:number, total:number}>}
 */
export async function buildVectors(root, docs, cfg) {
  const cache = loadVectorCache(root)
  if (cache.model !== cfg.embedModel) { cache.model = cfg.embedModel; cache.items = {} }
  const missing = []
  let reused = 0
  for (const doc of docs) {
    const sha = shaOf(embedTextOf(doc))
    const hit = cache.items[doc.rel]
    if (hit && hit.sha === sha && Array.isArray(hit.vec)) { reused++; continue }
    missing.push({ rel: doc.rel, sha, text: embedTextOf(doc) })
  }
  if (missing.length) {
    const vectors = await embedTexts(cfg, missing.map((m) => m.text))
    for (let i = 0; i < missing.length; i++) {
      cache.items[missing[i].rel] = { sha: missing[i].sha, vec: norm(vectors[i]) }
    }
    cache.at = new Date().toISOString()
    saveVectorCache(root, cache)
  }
  // forget entries for docs that no longer exist
  const alive = new Set(docs.map((d) => d.rel))
  for (const rel of Object.keys(cache.items)) if (!alive.has(rel)) delete cache.items[rel]
  return { embedded: missing.length, reused, total: docs.length }
}

/**
 * Semantic search: cosine pre-ranking, then rerank through the provider.
 * Throws SemanticUnavailable on any provider problem (callers fall back).
 * @param {(memDir:string)=>Array} [listDocs] injected to avoid a circular import
 */
export async function semanticSearch(root, query, { k = 5, docs = [], cfg = null } = {}) {
  const conf = cfg || semanticConfig(root)
  if (!hasApiKey(conf)) throw new SemanticUnavailable('未配置 API key', 'NO_KEY')
  const active = docs.filter((d) => String(d.meta.status || 'active') !== 'outdated')
  if (!active.length) return []
  await buildVectors(root, active, conf)
  const cache = loadVectorCache(root)
  const [qvec] = await embedTexts(conf, [String(query)])
  const qn = norm(qvec)
  const scored = active
    .map((d) => ({ doc: d, cosine: cosine(qn, cache.items[d.rel]?.vec || []) }))
    .filter((x) => Array.isArray(cache.items[x.doc.rel]?.vec))
    .sort((a, b) => b.cosine - a.cosine)
  if (!scored.length) return []
  const pool = scored.slice(0, RERANK_TOP)
  const order = await rerankDocs(conf, String(query), pool.map((x) => embedTextOf(x.doc)))
  if (!order.length) {
    return pool.slice(0, k).map((x) => ({ doc: x.doc, score: x.cosine, via: 'cosine' }))
  }
  return order.slice(0, Math.max(1, k)).map((r) => ({
    doc: pool[r.index].doc,
    score: r.score,
    via: 'rerank',
  }))
}
