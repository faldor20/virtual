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

export * from '@tanstack/virtual-core'

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
        reconcile(instance.getVirtualItems(), 'index')(s)
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
    notify: (sync: boolean) => void
    indexFromElement: (node: TItemElement) => number
    scrollElement: Element | Window | null
    options: { horizontal?: boolean; indexAttribute?: string }
  }
  const reLayoutPreservingSizes = (
    instance: Virtualizer<TScrollElement, TItemElement>,
  ) => {
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
  // — so a reused row can fail to (re)register under its correct key and end up
  // unobserved entirely. That row's later growth (e.g. a journal header whose
  // Backlinks panel renders late) then never fires a ResizeObserver, and its
  // stale size strands the offsets of every row after it (overlap).
  //
  // After the DOM settles (microtask — Solid has committed the new `data-index`
  // attributes by then), we walk the live rendered rows by `data-index`,
  // (re-)register each with `measureElement` (which observes the node under its
  // current key), and write its LIVE box to that index via `resizeItem`. We read
  // the box directly (offsetHeight/Width) because virtual-core's default
  // `measureElement(node)` short-circuits to the cached size when there's no RO
  // entry, so it can't correct an already-cached row. `resizeItem` no-ops on an
  // unchanged size, so this is cheap when nothing moved.
  const reObserveAndMeasureLive = (
    instance: Virtualizer<TScrollElement, TItemElement>,
  ) => {
    const internals = instance as unknown as MeasureInternals
    const scrollEl = internals.scrollElement
    if (!scrollEl || !('querySelectorAll' in scrollEl)) return
    const horizontal = internals.options.horizontal === true
    const attr = internals.options.indexAttribute ?? 'data-index'
    const nodes = (scrollEl as Element).querySelectorAll<HTMLElement>(
      `[${attr}]`,
    )
    for (const node of nodes) {
      // Register/observe under the node's CURRENT key (idempotent if already so).
      instance.measureElement(node as unknown as TItemElement)
      const index = internals.indexFromElement(node as unknown as TItemElement)
      if (index < 0) continue
      const size = node[horizontal ? 'offsetWidth' : 'offsetHeight']
      instance.resizeItem(index, size)
    }
  }

  // Whether the options effect has applied yet. The very first apply uses a real
  // measure() — its clear drops any stale initialMeasurementsCache seed and its
  // notify drives initial scroll-wiring + first paint. Subsequent applies (rows
  // added/removed, scrollMargin change, etc.) preserve measured sizes.
  let applied = false

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
      virtualizer.setOptions(resolved)
      if (!applied) {
        applied = true
        virtualizer.measure()
      } else {
        reLayoutPreservingSizes(virtualizer)
        // After the DOM settles the reindexed `data-index` attributes, re-observe
        // + re-read every rendered row's live box so a reused/grown/unobserved
        // row's size lands on its CURRENT key (resizeItem notifies → commit on
        // any real change).
        queueMicrotask(() => reObserveAndMeasureLive(virtualizer))
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
