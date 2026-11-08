/**
 * Reversible replacement of a text run (see inline.js).
 *
 * - Original top-level nodes of the run are kept in `origTop` and put back by restore().
 * - Inline wrapper elements (<a>, <b>...) are REUSED in the translated output, not cloned, so
 *   attributes and event listeners survive. Their original children are parked in a fragment and
 *   re-attached on restore.
 * - Nothing is added to the page (no attributes/classes), so a restored DOM equals the original.
 * - The converted template is fully validated before apply() touches the DOM.
 */
export class ReplacementStore {
  #records = [];
  #own = new WeakSet(); // nodes we inserted; used to avoid re-processing our own output

  isOwn(node) {
    return this.#own.has(node);
  }

  get size() {
    return this.#records.length;
  }

  /** `tree` comes from parseConverted(). Returns true if the DOM was changed. */
  apply(run, tree) {
    const { host, nodes, source } = run;
    if (!host.isConnected || nodes.some((n) => n.parentNode !== host)) return false;
    const doc = host.ownerDocument;
    const rec = { host, origTop: nodes.slice(), inserted: [], wraps: [] };
    const ref = nodes[nodes.length - 1].nextSibling;
    try {
      const frag = doc.createDocumentFragment();
      this.#build(tree.children, frag, source, rec, doc);
      rec.inserted = Array.from(frag.childNodes);
      for (const n of nodes) if (n.parentNode === host) host.removeChild(n);
      host.insertBefore(frag, ref);
    } catch {
      this.#undo(rec, host, ref);
      return false;
    }
    for (const n of rec.inserted) this.#own.add(n);
    this.#records.push(rec);
    return true;
  }

  #build(children, container, source, rec, doc) {
    for (const c of children) {
      if (c.text !== undefined) {
        container.appendChild(doc.createTextNode(c.text));
        continue;
      }
      const { el } = source.get(c.id);
      if (!c.atomic) {
        // Park children as an array (not a fragment): a nested reused element is moved out of its
        // original parent during the build and must still be found again on restore.
        const original = Array.from(el.childNodes);
        while (el.firstChild) el.removeChild(el.firstChild);
        rec.wraps.push({ el, original });
        this.#build(c.children, el, source, rec, doc);
      }
      container.appendChild(el);
    }
  }

  #undo(rec, host, ref) {
    for (const { el, original } of rec.wraps) this.#reattach(el, original);
    const frag = host.ownerDocument.createDocumentFragment();
    for (const n of rec.origTop) frag.appendChild(n);
    host.insertBefore(frag, ref && ref.parentNode === host ? ref : null);
  }

  #reattach(el, original) {
    while (el.firstChild) el.removeChild(el.firstChild);
    for (const n of original) el.appendChild(n);
  }

  #restoreRecord(rec) {
    for (const { el, original } of rec.wraps) this.#reattach(el, original);
    for (const n of rec.inserted) this.#own.delete(n);
    const attached = rec.inserted.filter((n) => n.parentNode);
    if (attached.length === 0) return false; // page removed our output; nothing to put back
    const parent = attached[0].parentNode;
    const ref = attached[attached.length - 1].nextSibling;
    for (const n of attached) n.parentNode.removeChild(n);
    const frag = parent.ownerDocument.createDocumentFragment();
    for (const n of rec.origTop) frag.appendChild(n);
    parent.insertBefore(frag, ref && ref.parentNode === parent ? ref : null);
    return true;
  }

  restoreAll() {
    let count = 0;
    for (const rec of this.#records.reverse()) if (this.#restoreRecord(rec)) count++;
    this.#records = [];
    return count;
  }
}
