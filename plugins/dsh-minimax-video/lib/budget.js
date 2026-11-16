/**
 * Cross-call budget ledger.
 *
 * A per-call `max_cost` cannot stop repeated small submissions from exceeding a
 * project's ceiling, so a named budget keeps a conservative running total:
 * submitted tasks and unknown outcomes stay reserved until they settle or a
 * human releases them for reconciliation. Reservations are written before the
 * network call under a file lock, so two concurrent submissions cannot both
 * spend the last unit of budget.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
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

const EPSILON = 1e-9

export class BudgetError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BudgetError'
  }
}

function round(value) {
  return Number(Number(value).toFixed(6))
}

function reservationUsage(ledger) {
  let held = 0
  let settled = 0
  for (const reservation of ledger.reservations ?? []) {
    if (reservation.status === 'held') held += Number(reservation.amount) || 0
    else if (reservation.status === 'settled') settled += Number(reservation.settled_amount ?? reservation.amount) || 0
  }
  return { held: round(held), settled: round(settled), used: round(held + settled) }
}

export class BudgetLedger {
  constructor(dir) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  fileFor(budgetId) {
    return join(this.dir, `budget-${idFileSegment(budgetId)}.json`)
  }

  load(budgetId) {
    const file = this.fileFor(budgetId)
    if (!existsSync(file)) throw new BudgetError(`unknown budget "${budgetId}"; create it with video_budget action=create first`)
    const ledger = readJson(file)
    if (ledger.budget_id !== budgetId) throw new BudgetError(`budget file ${file} does not match id ${budgetId}`)
    return ledger
  }

  /** Validate that a loaded ledger matches the declaration being ensured. */
  validateDeclaration(ledger, { budgetId, limit, currency }) {
    if (ledger === undefined || ledger === null || typeof ledger !== 'object') {
      throw new BudgetError(`budget "${budgetId}" exists but is unreadable; inspect the ledger file before continuing`)
    }
    if (ledger.budget_id !== budgetId) {
      throw new BudgetError(
        `budget file for "${budgetId}" declares budget_id "${ledger.budget_id}"; refusing to mix two budgets`,
      )
    }
    if (ledger.currency !== currency) {
      throw new BudgetError(
        `budget "${budgetId}" already exists in ${ledger.currency}; a caller cannot change its currency to ${currency}`,
      )
    }
    if (ledger.limit !== limit) {
      throw new BudgetError(
        `budget "${budgetId}" already exists with limit ${ledger.limit} ${ledger.currency}; this call asked for ${limit}. A call cannot raise or change a budget: align the project manifest or use video_budget action=amend with a reason`,
      )
    }
    return ledger
  }

  /** Create a budget, or validate that an existing one matches the declaration. */
  ensure({ budgetId, limit, currency, note, source = 'video_budget' }) {
    if (typeof budgetId !== 'string' || budgetId.trim().length === 0) {
      throw new BudgetError('budget id must be a non-empty string')
    }
    const id = budgetId.trim()
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      throw new BudgetError('budget limit must be a positive number')
    }
    if (!['CNY', 'USD'].includes(currency)) throw new BudgetError('budget currency must be CNY or USD')
    const file = this.fileFor(id)
    if (existsSync(file)) {
      return this.validateDeclaration(readJson(file), { budgetId: id, limit, currency })
    }
    const ledger = {
      schema: 1,
      budget_id: id,
      currency,
      limit,
      note: note ?? null,
      source,
      created_at: nowIso(),
      updated_at: nowIso(),
      reservations: [],
      amendments: [],
      audit: [{ at: nowIso(), action: 'create', source, limit, currency }],
    }
    try {
      createJsonExclusive(file, ledger)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // Another process won the create race. Re-read and validate its exact
      // declaration; never accept a different cap/currency just because the id
      // happened to match.
      let created
      try {
        created = readJson(file)
      } catch (readError) {
        throw new BudgetError(`budget "${id}" was created concurrently but cannot be read: ${readError.message}`)
      }
      return this.validateDeclaration(created, { budgetId: id, limit, currency })
    }
    return ledger
  }

  /** Non-mutating capacity check used by prepare/dry-run. */
  precheck(budgetId, amount, currency) {
    const ledger = this.load(budgetId)
    if (ledger.currency !== currency) {
      throw new BudgetError(`budget "${budgetId}" is in ${ledger.currency}, but this base URL bills in ${currency}`)
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new BudgetError('budget reservation needs a finite non-negative amount')
    }
    const { held, settled, used } = reservationUsage(ledger)
    const remaining = round(ledger.limit - used)
    const ok = amount <= remaining + EPSILON
    if (!ok) {
      throw new BudgetError(
        `budget "${budgetId}" has ${remaining.toFixed(2)} ${ledger.currency} left (limit ${ledger.limit.toFixed(2)}, held ${held.toFixed(2)}, settled ${settled.toFixed(2)}); this call needs a reservation of ${amount.toFixed(2)} ${ledger.currency}`,
      )
    }
    return { budget_id: ledger.budget_id, currency: ledger.currency, limit: ledger.limit, held, settled, used, remaining, amount: round(amount) }
  }

  /** Atomically reserve budget before the paid call. */
  reserve({ budgetId, recordId, amount, taskType, estimateAmount, note }) {
    const file = this.fileFor(budgetId)
    let reservation
    const ledger = updateJson(file, (current) => {
      if (current === undefined) throw new BudgetError(`unknown budget "${budgetId}"`)
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        throw new BudgetError('budget reservation needs a finite non-negative amount')
      }
      const usage = reservationUsage(current)
      const remaining = round(current.limit - usage.used)
      if (amount > remaining + EPSILON) {
        throw new BudgetError(
          `budget "${budgetId}" has ${remaining.toFixed(2)} ${current.currency} left (limit ${current.limit.toFixed(2)}, held ${usage.held.toFixed(2)}, settled ${usage.settled.toFixed(2)}); this call needs a reservation of ${round(amount).toFixed(2)} ${current.currency}`,
        )
      }
      reservation = {
        reservation_id: `res-${Date.now().toString(36)}-${randomToken(3)}`,
        record_id: recordId,
        task_id: null,
        task_type: taskType,
        amount: round(amount),
        estimate_amount: estimateAmount === undefined ? null : round(estimateAmount),
        status: 'held',
        created_at: nowIso(),
        updated_at: nowIso(),
        note: note ?? null,
      }
      return {
        ...current,
        updated_at: nowIso(),
        reservations: [...(current.reservations ?? []), reservation],
        audit: [
          ...(current.audit ?? []),
          {
            at: nowIso(),
            action: 'reserve',
            reservation_id: reservation.reservation_id,
            record_id: recordId,
            amount: reservation.amount,
            ...(note === undefined || note === null ? {} : { note }),
          },
        ],
      }
    })
    return { ledger, reservation }
  }

  attachTask({ budgetId, recordId, taskId }) {
    const file = this.fileFor(budgetId)
    updateJson(file, (current) => {
      if (current === undefined) return undefined
      return {
        ...current,
        updated_at: nowIso(),
        reservations: (current.reservations ?? []).map((reservation) =>
          reservation.record_id === recordId && reservation.status === 'held'
            ? { ...reservation, task_id: String(taskId), updated_at: nowIso() }
            : reservation,
        ),
      }
    })
  }

  /** Mark a successful/finished task's reservation as spent (list-price estimate). */
  settle({ budgetId, recordId, amount, reason }) {
    const file = this.fileFor(budgetId)
    let settled
    updateJson(file, (current) => {
      if (current === undefined) throw new BudgetError(`unknown budget "${budgetId}"`)
      const reservations = (current.reservations ?? []).map((reservation) => {
        if (reservation.record_id !== recordId || reservation.status !== 'held') return reservation
        const settledAmount = round(Math.min(Number(reservation.amount), Math.max(0, Number(amount))))
        settled = { ...reservation, status: 'settled', settled_amount: settledAmount, settled_at: nowIso(), updated_at: nowIso(), note: reason ?? reservation.note }
        return settled
      })
      return {
        ...current,
        updated_at: nowIso(),
        reservations,
        audit: [
          ...(current.audit ?? []),
          { at: nowIso(), action: 'settle', record_id: recordId, amount: settled?.settled_amount ?? null, reason: reason ?? null },
        ],
      }
    })
    return settled
  }

  /**
   * Release a held reservation. Callers must only use this for outcomes with no
   * confirmed charge (definite pre-acceptance rejection, confirmed queued
   * cancel, or a human reconciliation decision); an ambiguous or failed task
   * stays reserved.
   */
  release({ budgetId, recordId, reservationId, reason, outcome = 'released' }) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new BudgetError('releasing budget requires a reason')
    }
    const file = this.fileFor(budgetId)
    let released
    updateJson(file, (current) => {
      if (current === undefined) throw new BudgetError(`unknown budget "${budgetId}"`)
      const reservations = (current.reservations ?? []).map((reservation) => {
        if (reservation.status !== 'held') return reservation
        if (reservationId !== undefined && reservation.reservation_id !== reservationId) return reservation
        if (reservationId === undefined && reservation.record_id !== recordId) return reservation
        released = {
          ...reservation,
          status: 'released',
          release_reason: reason.trim(),
          release_outcome: outcome,
          released_at: nowIso(),
          updated_at: nowIso(),
        }
        return released
      })
      if (released === undefined) return undefined
      return {
        ...current,
        updated_at: nowIso(),
        reservations,
        audit: [
          ...(current.audit ?? []),
          { at: nowIso(), action: 'release', record_id: recordId ?? null, reservation_id: reservationId ?? null, reason: reason.trim(), outcome },
        ],
      }
    })
    if (released === undefined) {
      throw new BudgetError(`no held reservation found for ${reservationId ?? recordId ?? '(unspecified)'} in budget "${budgetId}"`)
    }
    return released
  }

  /** Deliberate budget change with an audit trail. */
  amend({ budgetId, limit, reason }) {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      throw new BudgetError('new budget limit must be a positive number')
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new BudgetError('changing a budget requires a reason')
    }
    const file = this.fileFor(budgetId)
    const ledger = updateJson(file, (current) => {
      if (current === undefined) throw new BudgetError(`unknown budget "${budgetId}"`)
      const usage = reservationUsage(current)
      if (limit + EPSILON < usage.used) {
        throw new BudgetError(
          `cannot lower budget "${budgetId}" to ${limit}: ${usage.used.toFixed(2)} ${current.currency} is already held/settled`,
        )
      }
      return {
        ...current,
        limit: round(limit),
        updated_at: nowIso(),
        amendments: [
          ...(current.amendments ?? []),
          { at: nowIso(), from: current.limit, to: round(limit), reason: reason.trim() },
        ],
        audit: [...(current.audit ?? []), { at: nowIso(), action: 'amend', from: current.limit, to: round(limit), reason: reason.trim() }],
      }
    })
    return ledger
  }

  summary(budgetId) {
    const ledger = this.load(budgetId)
    const usage = reservationUsage(ledger)
    return {
      budget_id: ledger.budget_id,
      currency: ledger.currency,
      limit: ledger.limit,
      held: usage.held,
      settled: usage.settled,
      used: usage.used,
      remaining: round(ledger.limit - usage.used),
      note: ledger.note,
      source: ledger.source,
      reservations: (ledger.reservations ?? []).slice(-10),
      amendments: ledger.amendments ?? [],
    }
  }

  list() {
    const names = readdirSync(this.dir)
    return names
      .filter((name) => name.startsWith('budget-') && name.endsWith('.json'))
      .map((name) => {
        const ledger = readJson(join(this.dir, name))
        return ledger === undefined ? undefined : this.summary(ledger.budget_id)
      })
      .filter((entry) => entry !== undefined)
  }
}

/** Render a budget summary as one line for tool output. */
export function formatBudget(summary) {
  return `budget ${summary.budget_id}: ${summary.remaining.toFixed(2)}/${summary.limit.toFixed(2)} ${summary.currency} remaining (held ${summary.held.toFixed(2)}, settled ${summary.settled.toFixed(2)})`
}
