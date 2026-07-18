import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  observeWindowOffset,
  observeWindowRect,
  windowScroll,
} from '@tanstack/virtual-core'

import {
  createEffect,
  createSignal,
  createStore,
  merge,
  onSettled,
  reconcile,
  runWithOwner,
} from 'solid-js'
import type { PartialKeys, VirtualizerOptions } from '@tanstack/virtual-core'
import {
  countVirtualRelayout,
  recordVirtualRelayout,
  virtualizerInstanceId,
} from '../../../../../src/perf/virtualRelayout'

export * from '@tanstack/virtual-core'

// Chrome DevTools Performance custom tracks — no-op under Node (no console.timeStamp).
function timeStamp(
  label: string,
  start: number,
  end: number,
  track: string,
  group: string,
  color: DevToolsTimeStampColor,
): void {
  if (typeof console.timeStamp === 'function') {
    console.timeStamp(label, start, end, track, group, color)
  }
}

function createVirtualizerBase<
  TScrollElement extends Element | Window,
  TItemElement extends Element,
>(
  options: VirtualizerOptions<TScrollElement, TItemElement>,
): Virtualizer<TScrollElement, TItemElement> {
  const resolvedOptions: VirtualizerOptions<TScrollElement, TItemElement> =
    merge(options)

  const instance = new Virtualizer<TScrollElement, TItemElement>(
    resolvedOptions,
  )
  const diagnosticsId = virtualizerInstanceId(instance)

  const [virtualItems, setVirtualItems] = createStore(
    instance.getVirtualItems(),
  )
  const [totalSize, setTotalSize] = createSignal(instance.getTotalSize())

  const handler = {
    get(
      target: Virtualizer<TScrollElement, TItemElement>,
      prop: keyof Virtualizer<TScrollElement, TItemElement>,
    ) {
      switch (prop) {
        case 'getVirtualItems':
          return () => virtualItems
        case 'getTotalSize':
          return () => totalSize()
        default:
          return Reflect.get(target, prop)
      }
    },
  }

  const virtualizer = new Proxy(instance, handler)
  virtualizer.setOptions(resolvedOptions)

  // Commit virtual-core's latest items/total-size into the reactive store.
  //
  // virtual-core's `onChange` can fire synchronously from inside an owned
  // reactive scope (the options effect's apply phase calls `measure()`, which
  // notifies; a flush can also process a queued resize while a computation is
  // on the stack). Solid 2.0 bans writes to a store/signal from an owned
  // scope, so we must commit DETACHED via `runWithOwner(null, …)` — which
  // removes the owned-write firewall so the write is accepted and reliably
  // scheduled whether onChange fired from an owned scope or a detached DOM
  // callback. Without it, an async `measureElement` resize (ResizeObserver →
  // resizeItem → notify) either throws (dev) or silently fails to re-flush
  // later items' offsets, leaving their `start` stuck on the estimate.
  const commit = (instance: Virtualizer<TScrollElement, TItemElement>) => {
    instance._willUpdate()
    runWithOwner(null, () => {
      setVirtualItems(s => {
        // Reconcile by `key`, NOT `index`. Consumers key their `<For>` by the
        // item's `key` (a stable per-row id). Index-keyed reconcile rewrites the
        // `key` field IN PLACE on every store row at/after a mid-list insert, so a
        // key-keyed `<For>` sees a row's key detach from its store-row identity and
        // reattach on the neighbour → it disposes + recreates that child (tearing
        // out its DOM, e.g. re-decoding an <img> → a visible flash on insert-above).
        // Keying the reconcile by the same field the `<For>` keys by makes an
        // insert a pure reorder of stable-identity rows. Item keys are unique within
        // a window (required by both reconcile and keyed `<For>`).
        reconcile(instance.getVirtualItems(), 'key')(s)
      })
      setTotalSize(instance.getTotalSize())
    })
  }

  onSettled(() => {
    const cleanup = virtualizer._didMount()
    virtualizer._willUpdate()
    return cleanup
  })

  // Re-layout on an options change WITHOUT throwing away dynamic measurements.
  //
  // `virtualizer.measure()` does: pendingMin=null; itemSizeCache.clear();
  // laneAssignments.clear(); itemSizeCacheVersion++; notify(false). Only the two
  // `.clear()`s are destructive — they wipe every dynamic `measureElement`
  // result on EVERY options change. Because the compute above spreads the
  // options proxy, the apply re-runs whenever any reactive option changes —
  // notably the `count` getter, which tracks the consumer's row list — so an
  // ordinary "add an entry" wiped all measured heights. A row whose DOM box
  // didn't change (e.g. a journal day header) then never re-fires its
  // ResizeObserver and was stranded at its estimate, so the next row overlapped
  // it (the multi-day journal-feed overlap).
  //
  // This is exactly `measure()` MINUS the two clears:
  //  - `pendingMin = null` + `itemSizeCacheVersion++` force getMeasurements to
  //    rebuild from index 0. It re-reads each row's MEASURED size by item key
  //    from the PRESERVED itemSizeCache, recomputing only offsets — so an
  //    unchanged-box row keeps its measured height across a count change.
  //  - `notify(false)` is load-bearing and must NOT be replaced with a direct
  //    commit(): paint of newly-appended (below-fold) rows is driven by the
  //    async ResizeObserver/scroll-settle `maybeNotify` cycle. Calling
  //    getVirtualItems() directly (as commit does) runs getVirtualIndexes,
  //    whose `maybeNotify.updateDeps` side-effect silently rebaselines
  //    maybeNotify to the CURRENT (small) range — so the later async settle sees
  //    "no change" and never fires onChange, and the appended rows never
  //    surface. notify(false) routes through onChange → commit the same way
  //    measure() does, keeping that cycle armed.
  //
  // The fields/method are "private" only in the type; at runtime they're plain
  // instance members (names preserved in the build).
  type MeasureInternals = {
    pendingMin: number | null
    itemSizeCacheVersion: number
    itemSizeCache: Map<unknown, number>
    elementsCache: Map<unknown, Element>
    notify: (sync: boolean) => void
    indexFromElement: (node: TItemElement) => number
    scrollElement: Element | Window | null
    options: {
      horizontal?: boolean
      indexAttribute?: string
      getItemKey: (index: number) => unknown
    }
  }
  const reLayoutPreservingSizes = (
    instance: Virtualizer<TScrollElement, TItemElement>,
  ) => {
    countVirtualRelayout('virtualizer.preserveSizeRelayout')
    const internals = instance as unknown as MeasureInternals
    internals.pendingMin = null
    internals.itemSizeCacheVersion++
    internals.notify(false)
  }

  // Re-observe + re-measure every rendered row against its CURRENT index.
  //
  // On a rows change that REINDEXES reused rows (e.g. a prepend), a keyed <For>
  // reuses the same DOM nodes but shifts their `data-index`. The consumer's
  // per-row `measureElement(node)` call fires DURING the reindex flush, when the
  // node's `data-index` attribute and the intended key are momentarily desynced
  // so a reused row can fail to (re)register under its correct key and end up
  // unobserved entirely. That row's later growth (e.g. a journal header whose
  // Backlinks panel renders late) then never fires a ResizeObserver, and its
  // stale size strands the offsets of every row after it (overlap).
  //
  // Scheduled on rAF (not a click microtask): a sync offsetHeight after a large
  // Solid flush forces style+layout of the whole dirty tree still attributed to
  // the click. Re-bind RO first; only force-read geometry when the key is new or
  // the node was not already bound under that key (RO owns later growth).
  // `resizeItem` no-ops on an unchanged size.
  const reObserveAndMeasureLive = (
    instance: Virtualizer<TScrollElement, TItemElement>,
  ) => {
    const start = performance.now()
    const internals = instance as unknown as MeasureInternals
    const scrollEl = internals.scrollElement
    if (!scrollEl || !('querySelectorAll' in scrollEl)) {
      const duration = performance.now() - start
      recordVirtualRelayout('virtualizer.reObserveAndMeasureLive', {
        source: 'virtualizer',
        kind: 'reObserveAndMeasureLive',
        instanceId: diagnosticsId,
        forcedOffsetReads: 0,
        duration,
      })
      return
    }
    const horizontal = internals.options.horizontal === true
    const attr = internals.options.indexAttribute ?? 'data-index'
    const nodes = (scrollEl as Element).querySelectorAll<HTMLElement>(
      `[${attr}]`,
    )
    let offsetReads = 0
    for (const node of nodes) {
      // Nested virtualizers (QueryTable, …) can share this scroll root. Their
      // items may also stamp an index attribute; measuring them here maps their
      // heights onto THIS instance's getItemKey(index) and permanently poisons
      // outer row sizes (stuck overlap until reload). Nested lists must use a
      // distinct indexAttribute; also skip any node under a descendant
      // [data-virtual] host (table body rows, etc.).
      let nested = false
      for (
        let parent = node.parentElement;
        parent && parent !== scrollEl;
        parent = parent.parentElement
      ) {
        if (parent.hasAttribute('data-virtual')) {
          nested = true
          break
        }
      }
      if (nested) continue

      const index = internals.indexFromElement(node as unknown as TItemElement)
      if (index < 0) {
        instance.measureElement(node as unknown as TItemElement)
        continue
      }
      const key = internals.options.getItemKey(index)
      const alreadyBound = internals.elementsCache.get(key) === node
      const hasSize = internals.itemSizeCache.has(key)
      // Register/observe under the node's CURRENT key (idempotent if already so).
      // options.measureElement + resizeItem run inside; that is the size source.
      instance.measureElement(node as unknown as TItemElement)
      // Same node + same key already measured: RO owns growth; skip forced layout.
      if (alreadyBound && hasSize) continue
      // Key already sized but rebound to a new node after virtual remount:
      // measureElement re-bound the RO. Do NOT force-overwrite with raw
      // offsetHeight — nested virtual carriers often report ~header-only height
      // before their body paints, which collapses scrollHeight and clamps Pane
      // scrollTop to the table head.
      if (hasSize) continue
      const size = node[horizontal ? 'offsetWidth' : 'offsetHeight']
      offsetReads++
      instance.resizeItem(index, size)
    }
    // Outlier custom track (Chrome DevTools Performance -> Show custom tracks).
    timeStamp(
      `reObserveAndMeasureLive id=${diagnosticsId} n=${offsetReads}`,
      start,
      performance.now(),
      'Virtualizer',
      'Outlier',
      'primary',
    )
    recordVirtualRelayout('virtualizer.reObserveAndMeasureLive', {
      source: 'virtualizer',
      kind: 'reObserveAndMeasureLive',
      instanceId: diagnosticsId,
      forcedOffsetReads: offsetReads,
      duration: performance.now() - start,
    })
  }

  // Whether the options effect has applied yet. The very first apply uses a real
  // measure() — its clear drops any stale initialMeasurementsCache seed and its
  // notify drives initial scroll-wiring + first paint. Subsequent applies (rows
  // added/removed, scrollMargin change, etc.) preserve measured sizes.
  let applied = false
  let previousCount: number | undefined
  let previousScrollMargin: number | undefined
  // Coalesce options-effect remeasures when count/options churn within one frame.
  let reObserveRaf = 0

  createEffect(
    () => ({
      ...merge(resolvedOptions, options, {
        onChange: (
          instance: Virtualizer<TScrollElement, TItemElement>,
          sync: boolean,
        ) => {
          commit(instance)
          options.onChange?.(instance, sync)
        },
      }),
    }),
    (resolved) => {
      const currentCount = resolved.count
      const currentScrollMargin = resolved.scrollMargin ?? 0
      const priorCount = previousCount
      const priorScrollMargin = previousScrollMargin
      const unchanged = priorCount === currentCount && priorScrollMargin === currentScrollMargin
      previousCount = currentCount
      previousScrollMargin = currentScrollMargin
      virtualizer.setOptions(resolved)
      if (!applied) {
        applied = true
        const t0 = performance.now()
        virtualizer.measure()
        recordVirtualRelayout('virtualizer.optionsEffectFirstMeasure', {
          source: 'virtualizer',
          kind: 'optionsEffectFirstMeasure',
          instanceId: diagnosticsId,
          previousCount: priorCount,
          currentCount,
          previousScrollMargin: priorScrollMargin,
          currentScrollMargin,
          overscan: resolved.overscan,
          countChanged: true,
          scrollMarginChanged: true,
          duration: performance.now() - t0,
        })
        timeStamp(
          `options-effect measure (first) id=${diagnosticsId} count=${currentCount} margin=${currentScrollMargin}`,
          t0,
          performance.now(),
          'Virtualizer',
          'Outlier',
          'secondary',
        )
      } else {
        const t0 = performance.now()
        reLayoutPreservingSizes(virtualizer)
        recordVirtualRelayout('virtualizer.optionsEffectPreservingRelayout', {
          source: 'virtualizer',
          kind: unchanged ? 'optionsEffectUnchanged' : 'optionsEffectPreservingRelayout',
          instanceId: diagnosticsId,
          previousCount: priorCount,
          currentCount,
          previousScrollMargin: priorScrollMargin,
          currentScrollMargin,
          overscan: resolved.overscan,
          countChanged: priorCount !== currentCount,
          scrollMarginChanged: priorScrollMargin !== currentScrollMargin,
          duration: performance.now() - t0,
        })
        timeStamp(
          `options-effect relayout id=${diagnosticsId} count=${priorCount}->${currentCount} margin=${priorScrollMargin}->${currentScrollMargin}`,
          t0,
          performance.now(),
          'Virtualizer',
          'Outlier',
          'secondary',
        )
        // After paint: data-index is settled; avoid forced layout on the click
        // microtask (see reObserveAndMeasureLive).
        if (reObserveRaf) return
        reObserveRaf = requestAnimationFrame(() => {
          reObserveRaf = 0
          reObserveAndMeasureLive(virtualizer)
        })
      }
    },
  )

  return virtualizer
}

export function createVirtualizer<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  options: PartialKeys<
    VirtualizerOptions<TScrollElement, TItemElement>,
    'observeElementRect' | 'observeElementOffset' | 'scrollToFn'
  >,
): Virtualizer<TScrollElement, TItemElement> {
  return createVirtualizerBase<TScrollElement, TItemElement>(
    merge(
      {
        observeElementRect: observeElementRect,
        observeElementOffset: observeElementOffset,
        scrollToFn: elementScroll,
      },
      options,
    ),
  )
}

export function createWindowVirtualizer<TItemElement extends Element>(
  options: PartialKeys<
    VirtualizerOptions<Window, TItemElement>,
    | 'getScrollElement'
    | 'observeElementRect'
    | 'observeElementOffset'
    | 'scrollToFn'
  >,
): Virtualizer<Window, TItemElement> {
  return createVirtualizerBase<Window, TItemElement>(
    merge(
      {
        getScrollElement: () =>
          typeof document !== 'undefined' ? window : null,
        observeElementRect: observeWindowRect,
        observeElementOffset: observeWindowOffset,
        scrollToFn: windowScroll,
        initialOffset: () =>
          typeof document !== 'undefined' ? window.scrollY : 0,
      },
      options,
    ),
  )
}
