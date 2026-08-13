/**
 * useComposerDraft — the composer's DRAFT behaviour, owned in one place.
 *
 * A chat surface is three things: a transcript, a protocol, and a composer. The
 * first two already live here (`ChatMessageList` + the row registry, and
 * `protocol/`). This is the third — not the composer's markup, which every
 * surface is entitled to draw differently, but the behaviour of the text while
 * the user is still writing it:
 *
 *   - what a follow-up choice does to the draft (and how it is read back off it)
 *   - where text goes when the server hands it back (a cancelled queue entry, a
 *     rejected submit) and the user has already started typing something else
 *   - when Enter means "send" and when it means "my IME is committing a candidate"
 *   - how tall the box may grow before it scrolls
 *   - how large a submit may be before it is refused client-side
 *
 * These had drifted into three implementations with DIFFERENT semantics — most
 * visibly the picked-option state, which the side panel derives from the draft
 * text while the main composer keeps a separate `Set` beside it. Two answers to
 * "is this option selected" is one too many: the draft is what gets submitted, so
 * the draft is the only honest source, and an option the user has since woven
 * into their own sentence correctly stops being a removable block.
 *
 * Deliberately Redux-free, API-free and copy-free, like the rest of this
 * directory: it takes state and returns behaviour, so a surface backed by a
 * Redux slot, by React Query, or by an embedding app's own store can all use it.
 * Two host helpers are REUSED rather than reimplemented — `useImeGuard` for the
 * composition Enter and `chatDrafts.mergeIntoDraft` for the append — because a
 * private copy of either would be one more spelling of the thing this module
 * exists to collapse.
 *
 * The draft may be UNCONTROLLED (the hook holds it; pass `initialDraft` at most)
 * or CONTROLLED (`draft` + `onDraftChange`, for a surface that already persists
 * the text elsewhere, as the main composer does per slot). Both are supported
 * from the start so the remaining consumers do not have to change this signature.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from 'react'
import { useImeGuard } from '../hooks/useImeGuard'
import { mergeIntoDraft as appendToDraft } from '../utils/chatDrafts'

/** Max auto-grow height (px) before the box scrolls instead of growing. */
const DEFAULT_MAX_HEIGHT = 240

/**
 * `useLayoutEffect` warns when it runs on a server render, and this hook is part of
 * a published surface an app may render outside the dashboard. The measurement is a
 * DOM read either way, so on a server there is nothing to do and `useEffect` is the
 * correct no-op.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Options forming the `, `-joined tail of `text`, in the order they appear.
 *
 * Longest match wins so an option that contains another plus the separator (`foo, bar`
 * next to `bar`) peels as itself. An option already peeled is not peeled twice: the tail
 * belongs to the picks, and an earlier occurrence is the user's own text.
 */
export function pickedFromDraft(text: string, options: readonly string[]): string[] {
  const picked: string[] = []
  let rest = text
  for (;;) {
    const hit = options
      .filter(o => o && !picked.includes(o) && (rest === o || rest.endsWith(`, ${o}`)))
      .sort((a, b) => b.length - a.length)[0]
    if (!hit) break
    picked.unshift(hit)
    rest = rest === hit ? '' : rest.slice(0, rest.length - hit.length - 2)
  }
  return picked
}

/**
 * UTF-8 size of `text` in bytes.
 *
 * Byte length, not `.length`: the limit exists because the server measures the
 * request body, and a draft of CJK or emoji is two to four times its code-unit
 * count. Sizing by characters would let a submit the server refuses through, and
 * the user would see a failure instead of the composer's own refusal.
 */
export function draftByteSize(text: string): number {
  return new TextEncoder().encode(text).length
}

export interface ComposerDraftOptions {
  /**
   * The choices offered alongside the last answer — normally straight from
   * `deriveFollowUpOptions`. Picks are read back off the draft against THIS list,
   * so an option that is no longer offered stops being a removable block.
   */
  followUpOptions?: readonly string[]
  /**
   * Size above which `exceedsByteLimit` reports true. Omitted or 0 = no limit.
   * The hook never blocks a send itself — the surface owns its own refusal and
   * its own wording for it.
   */
  maxBytes?: number
  /**
   * Cap for the auto-grown textarea, in px. Defaults to 240. Auto-grow only runs
   * for an element attached to `textareaRef`; a surface that sizes its own box
   * (or has no box to size) simply does not attach it.
   */
  maxHeight?: number
  /** UNCONTROLLED only: seed the draft. Read on first render, ignored after. */
  initialDraft?: string
  /**
   * CONTROLLED: the surface owns the text. When supplied, this value is what the
   * hook reads and every write is reported through `onDraftChange` instead of
   * being stored here.
   */
  draft?: string
  /** Required with `draft`. Receives the resolved next value, never an updater. */
  onDraftChange?: (next: string) => void
}

export interface ComposerDraft {
  draft: string
  /** Accepts a value or an updater, like `useState`'s setter. */
  setDraft: Dispatch<SetStateAction<string>>
  /** Attach to the textarea so it grows with content up to `maxHeight`. */
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /** Spread onto the input so the IME guard can see composition start/end. */
  composition: { onCompositionStart: () => void; onCompositionEnd: () => void }
  /**
   * Whether this key event is an IME committing a candidate rather than a real
   * keypress. Exposed for a surface whose key handler is too rich to delegate to
   * `submitOnEnter` — it still must not read a composition Enter as a submit.
   */
  isComposing: <T extends HTMLElement>(e: KeyboardEvent<T>) => boolean
  /** Append text to the draft, keeping whatever the user has already typed. */
  mergeIntoDraft: (incoming: string) => void
  /** Options currently forming the picked tail of the draft. */
  picked: ReadonlySet<string>
  /** Add or remove an option from the picked tail of the draft. */
  toggleOption: (option: string) => void
  /** `text` is above `maxBytes`. Always false when no limit was given. */
  exceedsByteLimit: (text: string) => boolean
  /**
   * Enter submits, Shift+Enter inserts a newline, and an Enter that is committing
   * an IME composition does neither. Pass the surface's own submit — this hook
   * never sends anything itself. Generic over the element so an `<input>`-based
   * composer can use it too.
   */
  submitOnEnter: <T extends HTMLElement>(e: KeyboardEvent<T>, submit: () => void) => void
}

export function useComposerDraft(opts: ComposerDraftOptions = {}): ComposerDraft {
  const {
    followUpOptions = [],
    maxBytes = 0,
    maxHeight = DEFAULT_MAX_HEIGHT,
    initialDraft = '',
    draft: controlledDraft,
    onDraftChange,
  } = opts
  const [internalDraft, setInternalDraft] = useState(initialDraft)
  const controlled = controlledDraft !== undefined
  const draft = controlled ? controlledDraft : internalDraft
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const ime = useImeGuard()

  // Read through refs so the setter identity is STABLE across renders. A setter that
  // changed every render would re-run any effect that lists it, and the side panel's
  // seed listener is registered in exactly such an effect.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const controlledRef = useRef(controlled)
  controlledRef.current = controlled
  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange

  const setDraft = useCallback<Dispatch<SetStateAction<string>>>(next => {
    if (!controlledRef.current) {
      // Passed through rather than resolved here, so React's own update queueing
      // still applies and two updaters in one tick compose instead of colliding.
      setInternalDraft(next)
      return
    }
    const value = typeof next === 'function' ? next(draftRef.current) : next
    onDraftChangeRef.current?.(value)
  }, [])

  // Auto-grow so a multi-line paste or a seeded quote is fully visible instead of
  // being clipped to the element's `rows` default, then scroll past `maxHeight`.
  //
  // Measured with `overflow: hidden` and the previous scroll position restored:
  // the measurement resets height, and a surface whose transcript sits in the same
  // flex column would otherwise see that intermediate and reflow visibly. The
  // element's own CSS floor (e.g. a `min-h-*` class) still decides the empty size,
  // so a surface keeps its own resting geometry.
  useIsomorphicLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const prevOverflow = el.style.overflow
    const prevScrollTop = el.scrollTop
    el.style.overflow = 'hidden'
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    el.style.overflow = prevOverflow
    el.scrollTop = prevScrollTop
  }, [draft, maxHeight])

  /**
   * Append, never substitute: both texts are typed work, and text the server has
   * handed back has no other home (its card or its request is already gone), so it
   * cannot be the one dropped. The host's own helper does the appending — the
   * reducer that stashes a released question already uses it, so a private copy
   * here would let the two halves of one release drift apart.
   */
  const mergeIntoDraft = useCallback((incoming: string) => {
    setDraft(prev => appendToDraft(prev, incoming))
  }, [setDraft])

  const picked = useMemo<ReadonlySet<string>>(
    () => new Set(pickedFromDraft(draft, followUpOptions)),
    [draft, followUpOptions],
  )

  // The exact text a toggle wrote, the base it was built from, AND the block it
  // appended, so removing the block can put punctuation back verbatim. The block is
  // part of the key, not just the payload: trusting `produced` alone made the memo
  // apply after the OFFERED options had shrunk, and the base it restored then
  // erased the picks that were no longer offered along with the one being removed.
  const lastJoinRef = useRef<{ produced: string; base: string; block: string } | null>(null)

  /**
   * Picking edits the DRAFT rather than sending: the text in the composer is what gets
   * submitted, so a choice stays amendable.
   *
   * The draft is the only record of what is picked, so the picked block is read back off it
   * and rewritten whole. Editing the text is therefore not a case to defend against: it
   * simply changes what the tail is, and an option the user has since woven into their own
   * sentence stops being highlighted because it is no longer a block this can remove.
   */
  const toggleOption = useCallback((option: string) => {
    setDraft(prev => {
      const current = pickedFromDraft(prev, followUpOptions)
      const block = current.join(', ')
      const memo = lastJoinRef.current
      let base: string
      if (block && memo && memo.produced === prev && memo.block === block) {
        // Untouched since this wrote it AND still describing the same block, so the
        // base is known exactly rather than inferred.
        base = memo.base
      } else if (block) {
        // `pickedFromDraft` only reports a tail, so the block is at the end by construction.
        base = prev.slice(0, prev.length - block.length)
        if (base.endsWith(', ')) base = base.slice(0, -2)
      } else {
        base = prev
      }
      const next = current.includes(option)
        ? current.filter(o => o !== option)
        : [...current, option]
      const newBlock = next.join(', ')
      if (!newBlock) {
        lastJoinRef.current = null
        return base
      }
      const tail = base.trimEnd()
      // A draft mid-sentence may already end with the separator; a second one would be
      // submitted verbatim. Appending just the space still lands on the `, ` shape the
      // block is read back by.
      const produced = !tail
        ? newBlock
        : tail.endsWith(',') ? `${tail} ${newBlock}` : `${tail}, ${newBlock}`
      lastJoinRef.current = { produced, base, block: newBlock }
      return produced
    })
  }, [followUpOptions, setDraft])

  const exceedsByteLimit = useCallback(
    (text: string) => maxBytes > 0 && draftByteSize(text) > maxBytes,
    [maxBytes],
  )

  const isComposing = useCallback(
    <T extends HTMLElement>(e: KeyboardEvent<T>) => ime.isComposing(e),
    [ime],
  )

  const submitOnEnter = useCallback(<T extends HTMLElement>(
    e: KeyboardEvent<T>,
    submit: () => void,
  ) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    // An IME sends a final Enter to COMMIT the candidate the user just chose. Reading
    // that as a submit sends a half-written question and is unrecoverable — the text is
    // already gone from the box. The guard is the host's, layered over the native flag,
    // because the native flag alone is false on that Enter in some browsers.
    if (ime.isComposing(e)) return
    e.preventDefault()
    submit()
  }, [ime])

  return {
    draft,
    setDraft,
    textareaRef,
    composition: ime.composition,
    isComposing,
    mergeIntoDraft,
    picked,
    toggleOption,
    exceedsByteLimit,
    submitOnEnter,
  }
}
