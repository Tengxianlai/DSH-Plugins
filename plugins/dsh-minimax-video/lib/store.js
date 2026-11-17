/**
 * Small durable-store primitives shared by the task journal, the budget ledger
 * and the prepared-plan store.
 *
 * Every persisted document is written to a sibling temp file, fsynced and then
 * renamed over its target, so a crash leaves either the old or the new complete
 * JSON file. Records that must never be overwritten use a hard link install:
 * linking fails atomically with EEXIST, which is what guards duplicate submits.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

/** SHA-256 hex digest of a string or Buffer. */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** UTC ISO timestamp. */
export function nowIso() {
  return new Date().toISOString()
}

/** Random, filesystem-safe id segment. */
export function randomToken(bytes = 4) {
  return randomBytes(bytes).toString('hex')
}

/** Turn arbitrary text into a short safe filename segment. */
export function safeSegment(value, max = 48) {
  const text = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, max)
  return text.length > 0 ? text : 'item'
}

/** Best-effort stable filename for a user-supplied id (keeps a hash suffix). */
export function idFileSegment(value) {
  return `${safeSegment(value)}-${sha256Hex(String(value)).slice(0, 8)}`
}

/**
 * Best-effort directory fsync so a rename/link survives a machine crash.
 * Linux/WSL support this; on filesystems or platforms that reject opening a
 * directory the call is ignored. Durability here is "as strong as the local
 * filesystem offers", not a database guarantee.
 */
export function fsyncDir(dir) {
  let fd
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // directory fsync is not portable; the atomic rename still prevents torn files
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

/** Write JSON durably without ever exposing a partially written target. */
export function atomicWriteJson(file, value, { mode = 0o600 } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${randomToken(3)}`
  const data = `${JSON.stringify(value, null, 2)}\n`
  const fd = openSync(temp, 'wx', mode)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
  fsyncDir(dirname(file))
}

/** Write JSON only if the target does not exist; EEXIST is the caller's signal. */
export function createJsonExclusive(file, value, { mode = 0o600 } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${randomToken(3)}`
  const data = `${JSON.stringify(value, null, 2)}\n`
  const fd = openSync(temp, 'wx', mode)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(temp, file)
    fsyncDir(dirname(file))
    return true
  } finally {
    try {
      unlinkSync(temp)
    } catch {
      // the link (or a failed link) is what matters
    }
  }
}

/** Read one JSON document, or undefined when it is absent. */
export function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text)
}

/** True when the path exists and is a regular file. */
export function fileExists(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function sleepSync(ms) {
  const wait = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(wait, 0, 0, ms)
}

/**
 * Proven-dead check for a lock owner on this host. EPERM means the pid exists
 * but belongs to another user, so it is treated as alive; never steal in that
 * case. A lock held by another host cannot be proven dead from here either.
 */
function ownerIsProvablyDead(owner) {
  if (owner === null || typeof owner !== 'object') return false
  if (owner.host !== hostname()) return false
  const pid = owner.pid
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

function sameLockOwner(left, right) {
  return (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    left.nonce !== undefined &&
    left.nonce === right.nonce &&
    left.pid === right.pid &&
    left.host === right.host
  )
}

function lockDiagnostic(lockFile, holder) {
  if (holder === null || typeof holder !== 'object') {
    return `${lockFile} is locked by an unreadable/foreign lock file; do not remove it blindly, inspect it manually (its owner cannot be proven dead)`
  }
  const where = `${holder.host ?? 'unknown-host'} pid ${holder.pid ?? '?'}`
  if (holder.host !== hostname()) {
    return `${lockFile} is locked from another host (${where}, created ${holder.created_at ?? 'unknown'}); this process cannot prove that owner dead and will not steal the lock`
  }
  if (ownerIsProvablyDead(holder)) {
    return `${lockFile} appears held by a dead owner (${where}); retry`
  }
  return `${lockFile} is held by a live process (${where}, created ${holder.created_at ?? 'unknown'}); refusing to steal an active lock, wait or resolve that process`
}

/**
 * Acquire a per-document advisory lock.
 *
 * The lock file records {pid, host, nonce, created_at} and is installed with a
 * durable hard link (no partially written lock). Only a lock from this host
 * whose pid is provably dead (ESRCH) is reclaimed automatically; a live,
 * EPERM, foreign-host or unreadable lock is never stolen, and timeout produces
 * a diagnostic instead of assuming age means death. Release removes the file
 * only when its nonce still matches this acquisition. Parent-directory fsync is
 * best effort.
 */
export function acquireLock(lockFile, { timeoutMs = 5_000 } = {}) {
  const dir = dirname(lockFile)
  mkdirSync(dir, { recursive: true })
  const owner = { pid: process.pid, host: hostname(), nonce: randomToken(8), created_at: nowIso() }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      createJsonExclusive(lockFile, owner)
      return () => {
        try {
          const current = readJson(lockFile)
          if (sameLockOwner(current, owner)) {
            unlinkSync(lockFile)
            fsyncDir(dir)
          }
        } catch {
          // never remove a lock we cannot prove is ours
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    let holder
    try {
      holder = readJson(lockFile)
    } catch {
      holder = null
    }
    if (ownerIsProvablyDead(holder)) {
      // Re-read before unlinking so a fresh owner that replaced the dead lock is
      // not accidentally removed between check and unlink.
      try {
        const again = readJson(lockFile)
        if (sameLockOwner(again, holder)) {
          unlinkSync(lockFile)
          fsyncDir(dir)
          continue
        }
      } catch {
        // fall through to wait/diagnostic
      }
    }
    if (Date.now() >= deadline) throw new Error(lockDiagnostic(lockFile, holder))
    sleepSync(15)
  }
}

/** Read-modify-write one JSON file under its lock. */
export function updateJson(file, mutate, options = {}) {
  const release = acquireLock(`${file}.lock`, options)
  try {
    const current = readJson(file)
    const next = mutate(current)
    if (next === undefined) return undefined
    atomicWriteJson(file, next)
    return next
  } finally {
    release()
  }
}
