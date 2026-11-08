// The message routing the real service worker does, for tests that wire a content-script converter straight to a
// translation service: convert -> service.convert, lookup -> service.lookup (cache only), hints -> none.
export function workerSend(svc, hints = {}) {
  return async (m) => {
    if (m.type === 'bf:lookup') return svc.lookup(m.payload, { useCache: m.useCache });
    if (m.type === 'bf:hints') return { ok: true, hints };
    return svc.convert(m.payload, { useCache: m.useCache });
  };
}
