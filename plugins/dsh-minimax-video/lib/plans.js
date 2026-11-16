/**
 * Prepared-plan store.
 *
 * `video_prepare` (or `dry_run:true`) stores the approved shape, estimate and
 * hard caps under a short-lived plan id. Execution must re-supply the same
 * arguments (fingerprint check) and claims the plan with one atomic rename, so
 * a confirmed plan can only be started once. The plan file contains hashes and
 * policy choices only: no prompt body, no media URL and no API credential.
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, nowIso, randomToken, readJson } from './store.js'

export class PlanError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PlanError'
  }
}

export class PlanStore {
  constructor({ dir, ttlSeconds = 1800 }) {
    this.dir = dir
    this.ttlSeconds = ttlSeconds
    mkdirSync(dir, { recursive: true })
  }

  planPath(planId) {
    return join(this.dir, `plan-${planId}.json`)
  }

  write(payload) {
    const planId = `p-${Date.now().toString(36)}-${randomToken(3)}`
    const created = Date.now()
    const record = {
      schema: 1,
      plan_id: planId,
      created_at: new Date(created).toISOString(),
      expires_at: new Date(created + this.ttlSeconds * 1000).toISOString(),
      consumed: false,
      ...payload,
    }
    atomicWriteJson(this.planPath(planId), record)
    return record
  }

  /**
   * Validate a plan without consuming it. Used before budget reservation and
   * the journal intent so a failure in those steps does not burn the plan.
   */
  peek(planId, { kind, fingerprint } = {}) {
    if (typeof planId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(planId)) {
      throw new PlanError('plan_id must be a prepared plan id such as p-xxxx')
    }
    const file = this.planPath(planId)
    if (!existsSync(file)) {
      const consumed = this.findClaimed(planId)
      throw new PlanError(
        consumed === undefined
          ? `unknown or expired plan_id "${planId}"; run video_prepare again`
          : `prepared plan "${planId}" was already consumed at ${consumed.consumed_at}; prepare a fresh plan`,
      )
    }
    const record = readJson(file)
    if (kind !== undefined && record.kind !== kind) {
      throw new PlanError(`prepared plan "${planId}" is for ${record.kind}, not ${kind}; prepare the right operation`)
    }
    if (fingerprint !== undefined && record.fingerprint !== fingerprint) {
      throw new PlanError(
        'arguments differ from the prepared plan (prompt, media bytes, model settings, contracts or cap changed); run video_prepare again',
      )
    }
    if (Date.parse(record.expires_at) < Date.now()) {
      throw new PlanError(`prepared plan "${planId}" expired at ${record.expires_at}; run video_prepare again`)
    }
    return record
  }

  /**
   * Atomically consume one plan. Throws when the id is unknown, already used,
   * expired, for another operation, or for different arguments.
   */
  claim(planId, { kind, fingerprint } = {}) {
    if (typeof planId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(planId)) {
      throw new PlanError('plan_id must be a prepared plan id such as p-xxxx')
    }
    const file = this.planPath(planId)
    if (!existsSync(file)) {
      const consumed = this.findClaimed(planId)
      throw new PlanError(
        consumed === undefined
          ? `unknown or expired plan_id "${planId}"; run video_prepare again`
          : `prepared plan "${planId}" was already consumed at ${consumed.consumed_at}; prepare a fresh plan`,
      )
    }
    const claimedFile = join(this.dir, `claimed-${planId}-${Date.now()}.json`)
    try {
      renameSync(file, claimedFile)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new PlanError(`prepared plan "${planId}" was consumed concurrently; prepare a fresh plan`)
      }
      throw error
    }
    const record = readJson(claimedFile)
    const consumedAt = nowIso()
    atomicWriteJson(claimedFile, { ...record, consumed: true, consumed_at: consumedAt })
    if (kind !== undefined && record.kind !== kind) {
      throw new PlanError(`prepared plan "${planId}" is for ${record.kind}, not ${kind}; prepare the right operation`)
    }
    if (fingerprint !== undefined && record.fingerprint !== fingerprint) {
      throw new PlanError(
        'arguments differ from the prepared plan (prompt, media bytes, model settings, contracts or cap changed); run video_prepare again',
      )
    }
    if (Date.parse(record.expires_at) < Date.now()) {
      throw new PlanError(`prepared plan "${planId}" expired at ${record.expires_at}; run video_prepare again`)
    }
    return { ...record, consumed_at: consumedAt, file: claimedFile }
  }

  findClaimed(planId) {
    let names
    try {
      names = readdirSync(this.dir)
    } catch {
      return undefined
    }
    for (const name of names) {
      if (!name.startsWith(`claimed-${planId}-`) || !name.endsWith('.json')) continue
      const record = readJson(join(this.dir, name))
      if (record !== undefined) return record
    }
    return undefined
  }
}

export function formatPlan(record) {
  return `prepared plan ${record.plan_id} (${record.kind}); expires ${record.expires_at}`
}
