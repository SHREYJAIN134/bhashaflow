// Dynamic-content watcher. Only started after the user translated the page AND opted in for the site.
// Our own DOM writes are discarded with takeRecords() (they are queued synchronously), so the
// observer never reacts to its own output and cannot loop.

export function createObserver({ root, onNodes, debounceMs = 300 }) {
  const pending = new Set();
  let timer = null;
  let running = false;
  let observer = null;

  const consider = (node) => {
    const el = node.nodeType === 1 ? node : node.nodeType === 3 && node.data.trim() ? node.parentElement : null;
    if (el && el.isConnected) pending.add(el);
  };

  async function flush() {
    timer = null;
    if (running || !pending.size) return;
    running = true;
    const nodes = [...pending].filter((n) => n.isConnected);
    pending.clear();
    // Outermost nodes only; descendants are covered by their ancestor's scan.
    const roots = nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
    try {
      await onNodes(roots);
    } finally {
      if (observer) observer.takeRecords(); // drop records caused by our own writes
      running = false;
      if (pending.size) schedule();
    }
  }

  function schedule() {
    if (timer === null) timer = setTimeout(flush, debounceMs);
  }

  return {
    start() {
      if (observer) return;
      const MO = root.ownerDocument.defaultView.MutationObserver;
      observer = new MO((records) => {
        for (const r of records) for (const n of r.addedNodes) consider(n);
        if (pending.size) schedule();
      });
      observer.observe(root, { childList: true, subtree: true });
    },
    /** Call after every batch of our own DOM writes. */
    discard() {
      if (observer) observer.takeRecords();
    },
    stop() {
      if (observer) observer.disconnect();
      observer = null;
      clearTimeout(timer);
      timer = null;
      pending.clear();
    },
    get active() {
      return observer !== null;
    },
  };
}
