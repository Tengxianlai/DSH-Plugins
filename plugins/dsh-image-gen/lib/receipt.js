/**
 * Automatic, redacted generation receipts.
 *
 * The receipt is written BEFORE the paid request (status `requested`) and again
 * after delivery (status `delivered` / `partial` / `failed`). That ordering is
 * the point: a killed process or a lost task id must still leave the prompt,
 * the model, the exact input list and the input hashes on disk, so a later
 * reviewer can tell which approved character card / scene card / keyframe was
 * actually sent instead of trusting a prose summary.
 *
 * Secrets never enter a receipt: no API key, no Authorization header, no signed
 * download URL. Remote reference URLs keep only scheme/host/path; query and
 * fragment are redacted. Cost is always marked as an estimate, or explicitly
 * unknown when the backend is token-billed.
 */
import { createHash, randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Bumped when the receipt shape changes in a way consumers must notice. */
export const RECEIPT_VERSION = 1

/** Lowercase hex SHA-256 of bytes or a UTF-8 string. */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/** ISO timestamp safe for a filename plus 8 random hex: 2026-11-16_10-30-00-1a2b3c4d. */
export function makeReceiptId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  return `${stamp}-${randomBytes(4).toString('hex')}`
}

/**
 * Strip everything that can carry a credential from a URL.
 *
 * User info (`user:pass@`), the query string (signed tokens, expires) and the
 * fragment are removed; host and path survive so the source stays traceable.
 */
export function redactUrl(value) {
  if (typeof value !== 'string') return String(value)
  if (!/^https?:\/\//i.test(value)) return value
  const hash = value.indexOf('#')
  const query = value.indexOf('?')
  const cut = Math.min(...[hash, query].filter((index) => index >= 0), Number.POSITIVE_INFINITY)
  const base = cut === Number.POSITIVE_INFINITY ? value : value.slice(0, cut)
  const suffix = cut === Number.POSITIVE_INFINITY ? '' : value.slice(cut)
  // Strip userinfo without a URL parser so a malformed URL still comes back safe.
  const sanitized = base.replace(/^(https?:\/\/)[^/@]*@/i, '$1')
  return suffix.length > 0 ? `${sanitized}[redacted]` : sanitized
}

const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi
const KEY_LIKE = /\b(sk|pk|ak)-[A-Za-z0-9_-]{8,}/g
const URL_TOKEN_PARAM =
  /([?&](?:token|access_token|api_key|apikey|key|signature|sig|auth|expires|x-amz-[a-z-]+|x-goog-[a-z-]+)=)[^&\s"'`]+/gi

/** Redact URLs, bearer tokens and key-shaped strings from free text. */
export function redactText(value) {
  if (typeof value !== 'string') return String(value)
  let text = value.replace(/https?:\/\/[^\s"'`<>]+/gi, (url) => redactUrl(url))
  text = text.replace(BEARER, '$1[redacted]')
  text = text.replace(KEY_LIKE, 'sk-[redacted]')
  text = text.replace(URL_TOKEN_PARAM, '$1[redacted]')
  return text
}

/** The `plugin` block stored on every receipt. */
export function pluginInfo() {
  let version = 'unknown'
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {
    // A missing manifest must not block a generation; keep the unknown marker.
  }
  return { name: 'dsh-image-gen', version }
}

/**
 * Create a file that must not already exist. `flag: 'wx'` makes the check and
 * the create one syscall, so two concurrent calls can never both win and no
 * existing delivery is overwritten.
 */
export function writeFileExclusive(file, bytes) {
  try {
    writeFileSync(file, bytes, { flag: 'wx' })
    return file
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`refusing to overwrite an existing file: ${file}`)
    }
    throw error
  }
}

/**
 * Write JSON atomically.
 *
 * `create: true` is the first write of a receipt: it uses link(2) from a unique
 * temp file, which fails with EEXIST instead of replacing another call's
 * receipt. Later updates of the same receipt are a normal atomic rename — the
 * file is owned by this receipt id, never by another call.
 */
export function writeReceipt(file, receipt, { create = false } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  const body = `${JSON.stringify(receipt, null, 2)}\n`
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  writeFileSync(temporary, body)
  const overwriteError = () => new Error(`refusing to overwrite an existing receipt: ${file}`)
  try {
    if (!create) {
      renameSync(temporary, file)
      return file
    }
    try {
      // link(2) is atomic and refuses to replace an existing path.
      linkSync(temporary, file)
      unlinkSync(temporary)
      return file
    } catch (error) {
      if (error?.code === 'EEXIST') throw overwriteError()
      // Some filesystems (e.g. drvfs) have no hardlinks; an exclusive direct
      // write still cannot clobber another call's receipt.
      try {
        writeFileSync(file, body, { flag: 'wx' })
        unlinkSync(temporary)
        return file
      } catch (fallbackError) {
        if (fallbackError?.code === 'EEXIST') throw overwriteError()
        throw fallbackError
      }
    }
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // the temp file is already gone
    }
    throw error
  }
}

/** Directory that holds receipts for one output directory. */
export function receiptDirFor(outDir) {
  return join(outDir, 'receipts')
}

/**
 * A receipt skeleton. Callers mutate `status`, `outputs`, `cost`, `failures`
 * and `finished_at` in place and write it again after delivery.
 */
export function makeReceipt({ id, label, manifest, request, inputs, cost, warnings }) {
  return {
    receipt_version: RECEIPT_VERSION,
    receipt_id: id,
    status: 'planned',
    created_at: new Date().toISOString(),
    finished_at: null,
    label: label ?? null,
    plugin: pluginInfo(),
    references_manifest:
      manifest === undefined
        ? null
        : {
            path: manifest.path,
            sha256: manifest.sha256,
            entries: manifest.entries.length,
            required: manifest.entries.filter((entry) => entry.required === true).length,
          },
    request,
    inputs,
    outputs: [],
    cost,
    warnings,
    failures: [],
    error: null,
  }
}
