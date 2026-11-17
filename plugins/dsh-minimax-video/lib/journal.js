/**
 * Durable paid-task ledger.
 *
 * Sequence for every submission:
 *   1. a `pending-<fingerprint>.json` intent is installed exclusively (EEXIST
 *      means another process already has the same request in flight);
 *   2. only then is the network called;
 *   3. the returned task id is written atomically to `task-<id>.json` before
 *      polling starts;
 *   4. an ambiguous submit outcome leaves the pending intent at
 *      `status: "unknown"`, which blocks a silent retry of the same request.
 *
 * Records are independent files updated under per-file locks, so one stuck
 * task cannot corrupt or block another. Persisted assets are sanitized by the
 * caller; this module only sees already-sanitized data.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  atomicWriteJson,
  createJsonExclusive,
  idFileSegment,
  nowIso,
  randomToken,
  readJson,
  updateJson,
} from './store.js'

export class DuplicateSubmissionError extends Error {
  constructor({ kind, record, file, fingerprint }) {
    const taskId = record?.task_id
    const recordId = record?.record_id
    super(
      kind === 'recent'
        ? `an identical request was already submitted ${taskId === undefined ? '' : `as task ${taskId} `}${recordId === undefined ? '' : `(record ${recordId}) `}recently; pass allow_duplicate:true to submit it again`
        : `a previous identical submission has an unresolved outcome (record ${recordId ?? 'unknown'}${taskId === undefined ? '' : `, task ${taskId}`}); it will not be retried silently. Check the MiniMax console, or pass allow_duplicate_risk:true with override_reason and prior_record_id ${recordId ?? '...'} to accept the duplicate-charge risk`,
    )
    this.name = 'DuplicateSubmissionError'
    this.kind = kind
    this.record = record
    this.file = file
    this.fingerprint = fingerprint
  }
}

const PENDING_PREFIX = 'pending-'
const TASK_PREFIX = 'task-'

export class TaskJournal {
  constructor(dir) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  intentPath(fingerprint) {
    return join(this.dir, `${PENDING_PREFIX}${fingerprint}.json`)
  }

  taskPath(taskId) {
    return join(this.dir, `${TASK_PREFIX}${idFileSegment(taskId)}.json`)
  }

  failedPath(fingerprint) {
    return join(this.dir, `failed-${fingerprint.slice(0, 16)}-${Date.now()}-${randomToken(3)}.json`)
  }

  /** Drop the internal file handle before persisting one record. */
  static persistable(record) {
    const { file: _file, ...rest } = record
    return rest
  }

  /** Read every record file; unreadable/corrupt files are reported, not hidden. */
  list() {
    const records = []
    const corrupt = []
    let names = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return { records, corrupt }
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = join(this.dir, name)
      try {
        const value = readJson(file)
        if (value === undefined) continue
        records.push({ ...value, file })
      } catch (error) {
        corrupt.push({ file, error: error.message })
      }
    }
    return { records, corrupt }
  }

  findTaskByFingerprint(fingerprint) {
    const { records } = this.list()
    return records
      .filter((record) => record.fingerprint === fingerprint && String(record.task_id ?? '').length > 0)
      .sort((a, b) => String(b.updated_at ?? b.created_at ?? '').localeCompare(String(a.updated_at ?? a.created_at ?? '')))[0]
  }

  /**
   * Install the submission intent before the network call. Throws
   * DuplicateSubmissionError when the same fingerprint is already in flight or
   * unresolved, or when the exclusive install loses a race.
   */
  createIntent(record) {
    const file = this.intentPath(record.fingerprint)
    const persisted = { ...TaskJournal.persistable(record), file: undefined }
    persisted.status = 'submitting'
    try {
      createJsonExclusive(file, TaskJournal.persistable(persisted))
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let existing
      try {
        existing = readJson(file)
      } catch {
        existing = undefined
      }
      const task = this.findTaskByFingerprint(record.fingerprint)
      const kind = existing?.status === 'unknown' || existing?.status === 'resolved' ? 'unknown' : task !== undefined ? 'recent' : 'inflight'
      throw new DuplicateSubmissionError({
        kind,
        record: existing ?? task,
        file,
        fingerprint: record.fingerprint,
      })
    }
    record.file = file
    record.status = 'submitting'
    return record
  }

  /** Remove an intent that never reached the network (safe: nothing was sent). */
  cancelIntent(record) {
    if (record?.file === undefined) return
    try {
      unlinkSync(record.file)
    } catch {
      // already gone
    }
    record.status = 'cancelled_before_submit'
  }

  /** Update a pending intent in place (unknown outcome, attempt notes). */
  writePending(record, patch = {}) {
    const next = { ...TaskJournal.persistable(record), ...patch, updated_at: nowIso() }
    atomicWriteJson(record.file, next)
    Object.assign(record, patch, { updated_at: next.updated_at })
    return record
  }

  /** Persist the task id immediately, then retire the intent file. */
  commitTask(record, taskId) {
    const finalFile = this.taskPath(taskId)
    const next = {
      ...TaskJournal.persistable(record),
      task_id: String(taskId),
      status: 'submitted',
      submitted_at: record.submitted_at ?? nowIso(),
      updated_at: nowIso(),
    }
    atomicWriteJson(finalFile, next)
    if (record.file !== undefined) {
      try {
        unlinkSync(record.file)
      } catch {
        // a crash between link and unlink leaves a pending file; findBlocking()
        // reconciles it with the task record by fingerprint
      }
    }
    Object.assign(record, next, { file: finalFile })
    return record
  }

  /**
   * Close an intent. A definite rejection (4xx / local failure) is safe to
   * record as failed; an ambiguous outcome stays unknown and keeps blocking.
   */
  closeIntent(record, { ambiguous, error, status }) {
    if (ambiguous) {
      return this.writePending(record, {
        status: 'unknown',
        last_error: error?.message ?? String(error),
        attempts: [...(record.attempts ?? []), { at: nowIso(), action: 'submit', outcome: 'unknown', error: error?.message ?? String(error) }],
      })
    }
    const finalFile = this.failedPath(record.fingerprint)
    const next = {
      ...TaskJournal.persistable(record),
      status: status ?? 'failed',
      last_error: error?.message ?? String(error),
      attempts: [...(record.attempts ?? []), { at: nowIso(), action: 'submit', outcome: 'definite_failure', error: error?.message ?? String(error) }],
      updated_at: nowIso(),
    }
    atomicWriteJson(finalFile, next)
    if (record.file !== undefined) {
      try {
        unlinkSync(record.file)
      } catch {
        // already gone
      }
    }
    Object.assign(record, next, { file: finalFile })
    return record
  }

  /** Read-modify-write one record (task, pending or failed). */
  update(record, patch) {
    if (record.file === undefined) throw new Error('cannot update a record without a file handle')
    const next = updateJson(record.file, (current) => {
      if (current === undefined) return undefined
      return { ...current, ...patch, updated_at: nowIso() }
    })
    if (next !== undefined) Object.assign(record, patch, { updated_at: next.updated_at, file: record.file })
    return record
  }

  findByTaskId(taskId) {
    const file = this.taskPath(taskId)
    if (!existsSync(file)) {
      const { records } = this.list()
      return records.find((record) => record.task_id !== undefined && String(record.task_id) === String(taskId))
    }
    const value = readJson(file)
    return value === undefined ? undefined : { ...value, file }
  }

  findByRecordId(recordId) {
    const { records } = this.list()
    return records.find((record) => record.record_id === recordId)
  }

  /**
   * What would block an identical submission right now?
   * Returns undefined, or {kind: 'inflight'|'unknown'|'recent', record, file}.
   */
  findBlocking(fingerprint, { dedupeWindowMs = 10 * 60 * 1000, now = Date.now() } = {}) {
    const pendingFile = this.intentPath(fingerprint)
    if (existsSync(pendingFile)) {
      let pending
      try {
        pending = readJson(pendingFile)
      } catch {
        return { kind: 'unknown', record: undefined, file: pendingFile }
      }
      if (pending?.status === 'unknown') return { kind: 'unknown', record: { ...pending, file: pendingFile }, file: pendingFile }
      const task = this.findTaskByFingerprint(fingerprint)
      if (task !== undefined) return { kind: 'recent', record: task, file: pendingFile }
      return { kind: 'inflight', record: { ...pending, file: pendingFile }, file: pendingFile }
    }
    const { records } = this.list()
    const matches = records
      .filter((record) => record.fingerprint === fingerprint && record.file !== pendingFile)
      .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    const unknown = matches.find((record) => record.status === 'unknown')
    if (unknown !== undefined) return { kind: 'unknown', record: unknown, file: unknown.file }
    const recent = matches.find((record) => {
      if (record.status !== 'submitted' && record.status !== 'succeeded') return false
      const created = Date.parse(record.submitted_at ?? record.created_at ?? '')
      return !Number.isFinite(created) || now - created <= dedupeWindowMs
    })
    if (recent !== undefined) return { kind: 'recent', record: recent, file: recent.file }
    return undefined
  }

  /**
   * Record an explicit override on the blocked record and move a pending
   * unknown intent aside so the new attempt can install its own intent.
   */
  acknowledgeBlocking(blocking, { overrideReason, kind, priorRecordId }) {
    const entry = {
      at: nowIso(),
      kind: 'duplicate_risk_override',
      reason: overrideReason,
      prior_record_id: priorRecordId,
      approved: kind,
    }
    if (blocking.file !== undefined && existsSync(blocking.file)) {
      const current = readJson(blocking.file)
      if (current !== undefined) {
        const seen = current.seen_from ?? []
        const updated = {
          ...current,
          resolved_at: nowIso(),
          resolution: entry,
          status: 'resolved',
          audit: [...(current.audit ?? []), entry],
          updated_at: nowIso(),
        }
        atomicWriteJson(blocking.file, updated)
        try {
          renameSync(blocking.file, join(this.dir, `resolved-${current.fingerprint?.slice(0, 16) ?? randomToken(4)}-${Date.now()}.json`))
        } catch {
          // another process already archived it
        }
        return
      }
    }
    if (blocking.record?.file !== undefined) {
      const file = blocking.record.file
      const updated = updateJson(file, (current) =>
        current === undefined
          ? undefined
          : {
              ...current,
              audit: [...(current.audit ?? []), entry],
              updated_at: nowIso(),
            },
      )
      if (updated !== undefined && blocking.record !== undefined) {
        blocking.record.audit = updated.audit
      }
    }
  }
}
