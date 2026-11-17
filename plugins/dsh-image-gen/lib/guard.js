/**
 * Reference provenance and the identity-root guard.
 *
 * Two failures drove this module:
 *   1. an approved HD scene plate with no people was replaced by a frame pulled
 *      from footage that had people in it;
 *   2. a poster face was "fixed" by re-prompting the opposite adjectives seven
 *      times, while passing the approved identity root directly worked.
 *
 * So the plugin does not try to rewrite the prompt. It makes the actual
 * reference list and its provenance visible (role / approval / source, hashed
 * into the receipt) and refuses an adjective-driven identity edit in an
 * explicit production context when no approved identity root is among the
 * references.
 *
 * `approved: true` is the caller's declaration, not an independent audit; the
 * only cryptographic check available here is a manifest `sha256` matching the
 * actual bytes. Receipts say so explicitly.
 *
 * The role/approval annotations and the optional manifest are plain JSON. No
 * sibling plugin module is imported, so this bundle stays installable alone.
 */
import { dirname } from 'node:path'

/** Accepted reference roles. */
export const REFERENCE_ROLES = Object.freeze([
  'identity_root',
  'character_card',
  'scene_card',
  'keyframe',
  'source_frame',
  'style_ref',
  'other',
])

/** Roles that may serve as the approved identity anchor of an edit. */
export const IDENTITY_ROOT_ROLES = Object.freeze(['identity_root', 'character_card'])

/** Roles that represent an approved production card rather than raw footage. */
export const CARD_ROLES = Object.freeze(['identity_root', 'character_card', 'scene_card', 'keyframe'])

/** Honest one-liner stored on every receipt. */
export const APPROVAL_POLICY =
  'approvals are caller-declared unless the references_file supplies a sha256 that matches the actual bytes; ' +
  'this plugin performs no independent approval audit'

const isHttp = (value) => /^https?:\/\//i.test(value)

/** Key used to match an argument image against its annotation. */
export function referenceKey(image, cwd, resolve) {
  return isHttp(image) ? image : resolve(cwd, image)
}

/** Human-facing reference label; URL query strings stay redacted. */
function displayRef(value, redactUrl) {
  return isHttp(value) ? redactUrl(value) : value
}

/**
 * Manifest keys accepted by `references_file`: a bare array, `{references: []}`
 * or `{assets: []}`. Unknown extra fields on an entry are ignored so a project
 * registry can carry its own metadata.
 */
function manifestEntriesOf(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed !== null && typeof parsed === 'object') {
    for (const key of ['references', 'assets']) {
      if (Array.isArray(parsed[key])) return parsed[key]
    }
  }
  throw new Error('references_file must contain an array, {references: [...]} or {assets: [...]}')
}

/** Read and hash the approved-asset manifest without importing any code. */
export function loadReferenceManifest(file, cwd, { readFileSync, resolve, sha256Hex }) {
  const path = resolve(cwd, file)
  let bytes
  try {
    bytes = readFileSync(path)
  } catch (error) {
    throw new Error(`cannot read references_file ${file}: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`references_file ${file} is not valid JSON: ${error.message}`)
  }
  const baseDir =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.project_root === 'string'
      ? resolve(dirname(path), parsed.project_root)
      : dirname(path)
  return { path, sha256: sha256Hex(bytes), baseDir, raw: manifestEntriesOf(parsed) }
}

const SHA256 = /^[0-9a-f]{64}$/i

/** Registry `kind` aliases mapped onto the receipt roles. */
const KIND_ROLE = Object.freeze({
  identity: 'identity_root',
  identity_root: 'identity_root',
  character: 'character_card',
  character_card: 'character_card',
  role_card: 'character_card',
  scene: 'scene_card',
  scene_card: 'scene_card',
  keyframe: 'keyframe',
  key_frame: 'keyframe',
  source_frame: 'source_frame',
  frame: 'source_frame',
  style: 'style_ref',
  style_ref: 'style_ref',
})

function roleOf(entry, { origin, index, requireRole }) {
  let role = entry.role
  if (role === undefined && typeof entry.kind === 'string') role = KIND_ROLE[entry.kind] ?? entry.kind
  if (role === undefined) {
    if (requireRole) {
      throw new Error(
        `${origin} entry ${index + 1} needs "role" (one of ${REFERENCE_ROLES.join(', ')}) so the receipt can tell an approved card from a frame`,
      )
    }
    return 'other'
  }
  if (typeof role !== 'string' || !REFERENCE_ROLES.includes(role)) {
    // A project registry may carry kinds this plugin does not model; those are
    // recorded as `other` rather than blocking the call. Explicit references
    // still have to name a supported role.
    if (origin !== 'references') return 'other'
    throw new Error(
      `${origin} entry ${index + 1} has role "${String(role)}"; use one of ${REFERENCE_ROLES.join(', ')}`,
    )
  }
  return role
}

/** `approved` may be a boolean (our shape) or an approval record from a registry. */
function approvalOf(entry) {
  if (entry.approved !== undefined) {
    if (typeof entry.approved !== 'boolean') throw new Error('"approved" must be a boolean')
    return entry.approved
  }
  const approval = entry.approval
  if (typeof approval === 'boolean') return approval
  if (typeof approval === 'string') return /(approv|accept|pass|lock)/i.test(approval)
  if (approval !== null && typeof approval === 'object') {
    const status = approval.status ?? approval.state ?? approval.decision
    if (typeof status === 'string') return /(approv|accept|pass|lock)/i.test(status)
  }
  return false
}

function evidenceOf(entry) {
  const raw = entry.approval_evidence ?? entry.approvalEvidence ?? (typeof entry.approval === 'string' ? entry.approval : undefined)
  if (raw === undefined) return undefined
  return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

function coerceEntry(entry, { origin, cwd, resolve, index, requireRole }) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${origin} entry ${index + 1} must be an object`)
  }
  const image = entry.image ?? entry.path
  if (typeof image !== 'string' || image.trim().length === 0) {
    throw new Error(`${origin} entry ${index + 1} needs a non-empty "image" (or "path")`)
  }
  for (const field of ['source', 'note', 'id', 'asset_id']) {
    if (entry[field] !== undefined && typeof entry[field] !== 'string') {
      throw new Error(`${origin} entry ${index + 1}: "${field}" must be a string`)
    }
  }
  let required = false
  if (entry.required !== undefined) {
    if (typeof entry.required !== 'boolean') {
      throw new Error(`${origin} entry ${index + 1}: "required" must be a boolean`)
    }
    required = entry.required
  }
  let rootIds
  if (entry.root_ids !== undefined) {
    if (!Array.isArray(entry.root_ids) || entry.root_ids.some((id) => typeof id !== 'string')) {
      throw new Error(`${origin} entry ${index + 1}: "root_ids" must be an array of asset ids`)
    }
    rootIds = Array.from(entry.root_ids)
  }
  let expectedSha256
  let sha256Invalid = false
  if (entry.sha256 !== undefined) {
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256.trim())) {
      if (origin === 'references') {
        throw new Error(`${origin} entry ${index + 1}: "sha256" must be 64 hex characters`)
      }
      // A registry may carry an audit hash this plugin cannot compare; unused
      // entries are ignored, a used one rejects the call with the same message.
      sha256Invalid = true
    } else {
      expectedSha256 = entry.sha256.trim().toLowerCase()
    }
  }
  let approved
  try {
    approved = approvalOf(entry)
  } catch (error) {
    throw new Error(`${origin} entry ${index + 1}: ${error.message}`)
  }
  return {
    image,
    key: referenceKey(image, cwd, resolve),
    role: roleOf(entry, { origin, index, requireRole }),
    approved: approved === true,
    source: entry.source,
    note: entry.note,
    assetId: entry.id ?? entry.asset_id,
    required,
    rootIds,
    expectedSha256,
    sha256Invalid,
    approvalEvidence: evidenceOf(entry),
    origin,
  }
}

/**
 * Merge explicit `references` with an optional manifest, validate both against
 * the images actually being sent, and return one annotation map.
 *
 * @returns {{annotations: Map<string, object>, manifest?: object, warnings: string[]}}
 */
export function collectReferences({
  images,
  cwd,
  references,
  referencesFile,
  readFileSync,
  resolve,
  sha256Hex,
  redactUrl,
  loadManifest = loadReferenceManifest,
}) {
  const keys = new Map(images.map((image) => [referenceKey(image, cwd, resolve), image]))
  const annotations = new Map()
  const fromManifest = new Set()
  const warnings = []
  const display = (key) => displayRef(key, redactUrl)

  const add = (entry) => {
    if (!keys.has(entry.key)) {
      throw new Error(
        `${entry.origin} entry "${display(entry.key)}" is not one of the images being sent ` +
          `(${images.map((image) => display(referenceKey(image, cwd, resolve))).join(', ') || 'none'})`,
      )
    }
    if (annotations.has(entry.key)) {
      throw new Error(`reference "${display(entry.key)}" is annotated twice`)
    }
    annotations.set(entry.key, entry)
  }

  let manifest
  if (referencesFile !== undefined) {
    manifest = loadManifest(referencesFile, cwd, { readFileSync, resolve, sha256Hex })
    const entries = manifest.raw.map((entry, index) =>
      coerceEntry(entry, { origin: 'references_file', cwd, resolve, index, requireRole: false }),
    )
    manifest.entries = entries
    for (const entry of entries) {
      // A project registry stores paths relative to the project root (or, for an
      // exported list, the manifest's own directory). Match those candidates
      // against the images before writing them off as unrelated.
      if (!keys.has(entry.key) && !isHttp(entry.image)) {
        for (const base of [manifest.baseDir, dirname(manifest.path)]) {
          const candidate = referenceKey(resolve(base, entry.image), cwd, resolve)
          if (keys.has(candidate)) {
            entry.key = candidate
            break
          }
        }
      }
      if (!keys.has(entry.key)) continue
      if (entry.sha256Invalid) {
        throw new Error(`references_file entry for "${display(entry.key)}": "sha256" must be 64 hex characters`)
      }
      add(entry)
      fromManifest.add(entry.key)
    }
  }

  if (references !== undefined) {
    if (!Array.isArray(references)) {
      throw new Error('references must be an array of {image, role, approved, source} objects')
    }
    let overridden = 0
    for (const [index, entry] of references.entries()) {
      const coerced = coerceEntry(entry, { origin: 'references', cwd, resolve, index, requireRole: true })
      if (fromManifest.has(coerced.key)) {
        // An explicit reference may refine role/approval wording, but the
        // manifest's required flag, expected hash and lineage stay in force so
        // an override cannot talk its way past the contract.
        const declared = annotations.get(coerced.key)
        annotations.set(coerced.key, {
          ...declared,
          role: coerced.role,
          approved: coerced.approved,
          source: coerced.source ?? declared.source,
          note: coerced.note ?? declared.note,
          approvalEvidence: coerced.approvalEvidence ?? declared.approvalEvidence,
          origin: 'references+references_file',
        })
        fromManifest.delete(coerced.key)
        overridden += 1
        continue
      }
      add(coerced)
    }
    if (overridden > 0) {
      warnings.push('explicit references override the references_file entry for the same image')
    }
  }

  // Required references are the executable part of the production contract:
  // missing one blocks before any paid request, not just a warning.
  if (manifest !== undefined) {
    const used = new Set(annotations.keys())
    const missing = manifest.entries.filter((entry) => entry.required === true && !used.has(entry.key))
    if (missing.length > 0) {
      const listed = missing
        .map((entry) => `${display(entry.key)} (${entry.role}${entry.assetId === undefined ? '' : `, id ${entry.assetId}`})`)
        .join('; ')
      throw new Error(
        `references_file marks ${missing.length} reference(s) as required for this operation, but they were not ` +
          `passed in images: ${listed}. Pass every required reference; a frame, a different asset or a text-only ` +
          'retry does not satisfy the contract.',
      )
    }
  }

  return { annotations, manifest, warnings }
}

/**
 * Regexes for prompts that ask to change a face/identity. They target concrete
 * edit verbs and adjective-driven retries ("让脸更年轻", "五官再硬朗一点"); plain
 * descriptions and preservation wording are handled separately.
 */
const IDENTITY_EDIT_PATTERNS = Object.freeze([
  /换(?:个|张|一张)?脸/,
  /(?:替换|换掉|换成|换|改|修饰|修|重绘|重做|重塑|调整|修复)(?:一下|下|这|那|他的|她的|人物的|海报里的|照片里的|角色的)?(?:张|个|一张)?(?:脸|面部|五官|长相|容貌|面孔|人脸)/,
  /(?:脸|面部|五官|长相|容貌|面孔|人脸)[^，。；,;\n]{0,8}(?:改|修饰|修|重绘|重做|重塑|调整|修复|换掉|替换|换成)/,
  /(?:五官|长相|容貌|脸型|面孔|面部|脸)[^，。；,;\n]{0,10}(?:更|再|稍微|略|有点|过于|太)(?:年轻|老|瘦|胖|帅|美|成熟|硬朗|柔和|清秀|沧桑|稚嫩|像)/,
  /(?:更|再|稍微|略|有点|过于|太)(?:年轻|老|瘦|胖|帅|美|成熟|硬朗|柔和|清秀|沧桑|稚嫩)[^，。；,;\n]{0,6}(?:的脸|面部|五官|长相|脸)/,
  /(?:还|又|仍然|还是)?(?:不太?像|更像)(?:本人|原型|参考|照片|真人|那个人|角色)/,
  /(?:replace|change|swap|fix|redo|adjust|retouch)\s+(?:the\s+|his\s+|her\s+)?(?:face|facial features|likeness|head)\b/i,
  /(?:make|look)\s+(?:(?:him|her|the person)\s+)?(?:more|less)\s+(?:like|young|old|thin|handsome|pretty)\b/i,
])

/** The first identity-edit phrase in the prompt, if any. */
export function identityEditPhrase(prompt) {
  for (const pattern of IDENTITY_EDIT_PATTERNS) {
    const match = pattern.exec(prompt)
    if (match !== null) return match[0]
  }
  return undefined
}

/**
 * "不要改脸 / 保持五官不变 / do not change the face" is an instruction to keep
 * the identity, not to edit it. The edit phrase must not be inside such a
 * preservation clause.
 */
const PRESERVATION_BEFORE =
  /(不要|不用|不需要|无需|别|勿|禁止|避免|不得|保持|保留|维持|不变|一致|相同|不要动|do\s+not|don't|dont|never|keep|preserve|maintain|same|without)\s*$/i

function preservationContext(prompt, phrase) {
  const at = prompt.indexOf(phrase)
  if (at < 0) return false
  const before = prompt.slice(Math.max(0, at - 16), at)
  return PRESERVATION_BEFORE.test(before)
}

/** Prompts that explicitly describe creating a new character, not editing one. */
const NEW_CHARACTER =
  /(新角色|新人物|全新角色|全新人物|另一个角色|换个角色|重设计|重新设计|概念设计|概念图|角色设定|新造型|new character|new character design|concept art|redesign|new design)/i

/** Prompts that refer to an existing, already-decided identity or plate. */
const EXISTING_IDENTITY =
  /(已批准|批准|原图|原版|上一版|上一张|上一条|之前那版|这版|海报|定妆|身份|本人|角色卡|场景卡|关键帧|参考图|基础图|approved|identity|previous|existing plate)/i

function unusedApprovedRoots(manifest, annotations) {
  if (manifest === undefined) return []
  const used = new Set(annotations.keys())
  const hasRequired = manifest.entries.some((entry) => entry.required === true)
  // When the root CLI exported a required list, that list is authoritative:
  // unrelated approved roots must not be dragged in just to satisfy a guard.
  return manifest.entries.filter(
    (entry) =>
      entry.approved === true &&
      IDENTITY_ROOT_ROLES.includes(entry.role) &&
      !used.has(entry.key) &&
      (!hasRequired || entry.required === true),
  )
}

/**
 * Refuse adjective-driven identity edits when a production contract exists but
 * no approved identity anchor was supplied.
 *
 * Hard refusal is deliberately narrow:
 *   - preservation wording never triggers it;
 *   - new-character concept design never triggers it;
 *   - it needs either an explicit references_file (the project contract) or a
 *     prompt that refers to an existing identity/plate.
 * Everything else only warns. Text-to-image is never refused: a new face may
 * legitimately not have an approved root yet.
 *
 * @returns {{identityEditPrompt: boolean, identityPreservationPrompt: boolean, warnings: string[]}}
 */
export function evaluateIdentityGuard({ prompt, images, annotations, manifest, redactUrl }) {
  const phrase = identityEditPhrase(prompt)
  const display = (key) => displayRef(key, redactUrl)
  if (phrase === undefined) {
    return { identityEditPrompt: false, identityPreservationPrompt: false, warnings: [] }
  }
  if (preservationContext(prompt, phrase)) {
    return { identityEditPrompt: false, identityPreservationPrompt: true, warnings: [] }
  }

  const newCharacter = NEW_CHARACTER.test(prompt)
  const warnings = []
  const passedRoots = [...annotations.values()].filter((entry) => IDENTITY_ROOT_ROLES.includes(entry.role))
  const declaredApprovedRoots = passedRoots.filter((entry) => entry.approved === true)
  const unused = unusedApprovedRoots(manifest, annotations)
  const existingContext = manifest !== undefined || existingIdentityMarker(prompt)

  if (images.length === 0) {
    if (!newCharacter) {
      warnings.push(
        `prompt asks to change a face/identity ("${phrase}") but this is text-to-image: there is no approved ` +
          'identity root to anchor. Pass the approved character card / identity root as an image reference ' +
          'instead of relying on adjectives.',
      )
    }
    return { identityEditPrompt: true, identityPreservationPrompt: false, warnings }
  }

  if (newCharacter) {
    warnings.push(
      `prompt asks to change a face/identity ("${phrase}") in a new-character/concept context; no approved ` +
        'identity root is required, but declare the reference roles so the receipt shows what anchored the design.',
    )
    return { identityEditPrompt: true, identityPreservationPrompt: false, warnings }
  }

  if (declaredApprovedRoots.length > 0) {
    warnings.push(
      `prompt asks to change a face/identity ("${phrase}") while an approved identity reference is present ` +
        `(${declaredApprovedRoots.map((entry) => display(entry.key)).join(', ')}). The root is the anchor; ` +
        'approval is caller-declared here — check the receipt inputs and prefer reusing it over opposite adjectives.',
    )
    return { identityEditPrompt: true, identityPreservationPrompt: false, warnings }
  }

  if (unused.length > 0) {
    throw new Error(
      `identity edit refused before any request: the prompt asks to change a face/identity ("${phrase}"), and ` +
        `${manifest.path} declares approved identity root(s) that were NOT passed as references: ` +
        `${unused.map((entry) => display(entry.key)).join(', ')}. Pass the approved root directly in \`images\` ` +
        'and declare it with references:[{image:"<path>", role:"identity_root", approved:true, source:"<approval record>"}], ' +
        'instead of retrying with opposite adjectives. Run dry_run first to inspect the plan.',
    )
  }

  if (existingContext) {
    const note =
      annotations.size === 0
        ? ' No references metadata was given either, so the plugin cannot tell an approved root from a frame.'
        : ''
    throw new Error(
      `identity edit refused before any request: the prompt asks to change a face/identity ("${phrase}") in an ` +
        `existing-identity context${manifest === undefined ? '' : ` (references_file: ${manifest.path})`}, ` +
        `but none of the ${images.length} reference image(s) is declared as an approved identity root.${note} ` +
        'Editing an approved face with opposite adjectives is what failed repeatedly; pass the approved ' +
        'character card / identity root directly in `images` and declare it with ' +
        'references:[{image:"<path>", role:"identity_root", approved:true, source:"<approval record>"}], ' +
        'then rerun (dry_run first if you want to inspect the plan and cost).',
    )
  }

  warnings.push(
    `prompt asks to change a face/identity ("${phrase}") and no caller-declared approved identity root was ` +
      'supplied. If an approved character card / identity root exists, pass it directly instead of relying on ' +
      'adjectives; if this is untested candidate iteration, the receipt will record the unapproved inputs.',
  )
  return { identityEditPrompt: true, identityPreservationPrompt: false, warnings }
}

function existingIdentityMarker(prompt) {
  return EXISTING_IDENTITY.test(prompt)
}

/**
 * Warnings that make low approved-asset reuse visible at call time instead of
 * after a rejected poster.
 */
export function reuseWarnings({ images, annotations, manifest, redactUrl }) {
  const warnings = []
  const display = (key) => displayRef(key, redactUrl)
  if (images.length > 0 && annotations.size === 0) {
    warnings.push(
      'no references metadata: the receipt still hashes every input file, but role/approved/source are ' +
        'unset, so approved character/scene/keyframe reuse is not auditable. Pass references.',
    )
  }
  for (const entry of annotations.values()) {
    if (entry.approved === true && entry.source === undefined && entry.approvalEvidence === undefined) {
      warnings.push(
        `reference "${display(entry.key)}" is marked approved (caller-declared) without a source or approval ` +
          'evidence; the receipt cannot show what the approval came from.',
      )
    }
    if (entry.approved !== true && CARD_ROLES.includes(entry.role)) {
      warnings.push(
        `${entry.role} reference "${display(entry.key)}" is not approved (approval is caller-declared); ` +
          'an approved HD original should be preferred over a fresh frame or screenshot.',
      )
    }
  }
  const hasSourceFrame = [...annotations.values()].some((entry) => entry.role === 'source_frame')
  const hasApprovedCard = [...annotations.values()].some(
    (entry) => entry.approved === true && CARD_ROLES.includes(entry.role),
  )
  if (hasSourceFrame && !hasApprovedCard) {
    warnings.push(
      'the reference set contains a source_frame (a frame taken from footage) and no approved ' +
        'character/scene/keyframe card. If an approved HD original exists, pass it instead: a video frame may ' +
        'carry people or lower resolution that the approved plate does not.',
    )
  }
  if (manifest !== undefined) {
    const required = manifest.entries.filter((entry) => entry.required === true)
    const used = new Set(annotations.keys())
    const unused = manifest.entries.filter(
      (entry) => entry.approved === true && entry.required !== true && !used.has(entry.key),
    )
    for (const entry of required) {
      if (entry.expectedSha256 === undefined) {
        warnings.push(
          `required reference "${display(entry.key)}" has no sha256 in ${manifest.path}; its presence is enforced ` +
            'but content drift cannot be detected. Export a sha256 with every required entry.',
        )
      }
    }
    // Required entries are enforced before the request; the rest is only a
    // note so a caller never feels obliged to stuff every approved asset in
    // and mix scene/character viewpoints.
    if (unused.length > 0 && required.length === 0) {
      const listed = unused.slice(0, 5).map((entry) => display(entry.key)).join(', ')
      warnings.push(
        `${unused.length} approved asset(s) from ${manifest.path} are available but not marked required and not ` +
          `passed: ${listed}${unused.length > 5 ? ', …' : ''}. Only required references must be passed.`,
      )
    }
  }
  return warnings
}
