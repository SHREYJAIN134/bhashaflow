// A stand-in for the `chrome.*` APIs the extension uses, wiring the REAL popup, content script and service
// worker modules together inside one Node process. It is a simulation (no browser, no isolated worlds), but
// the message protocol is faithful where it matters: messages and replies are JSON-cloned like Chrome does,
// a listener must return true to answer asynchronously, and a message nobody answers rejects.

export function createFakeChrome({ tabUrl = 'https://example.com/article', storage = {} } = {}) {
  const lists = { sw: [], content: [] };
  let registerAs = 'sw';
  const installed = [];
  const data = { ...storage };
  const sent = []; // every message, for assertions
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function dispatch(list, message, label) {
    sent.push({ to: label, message: clone(message) });
    return new Promise((resolve, reject) => {
      if (!list.length) { reject(new Error('Could not establish connection. Receiving end does not exist.')); return; }
      let answered = false;
      let willAnswerLater = false;
      const respond = (value) => { if (!answered) { answered = true; resolve(clone(value)); } };
      for (const listener of [...list]) {
        let result;
        try { result = listener(clone(message), { id: 'test' }, respond); } catch (e) { reject(e); return; }
        if (result === true) willAnswerLater = true;
      }
      if (!answered && !willAnswerLater) reject(new Error('The message port closed before a response was received.'));
    });
  }

  const pick = (keys) => {
    if (keys === undefined || keys === null) return clone(data);
    if (typeof keys === 'string') return keys in data ? { [keys]: clone(data[keys]) } : {};
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
    return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? clone(data[k]) : d])); // defaults object
  };

  const hooks = { onExecute: async () => {} };
  const chrome = {
    storage: {
      local: {
        async get(keys) { return pick(keys); },
        async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = clone(v); },
        async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
      },
    },
    runtime: {
      id: 'bhashaflow-test',
      onInstalled: { addListener: (fn) => installed.push(fn) },
      onMessage: { addListener: (fn) => lists[registerAs].push(fn) },
      sendMessage: (message) => dispatch(lists.sw, message, 'service-worker'),
    },
    tabs: {
      query: async () => [{ id: 1, url: tabUrl, active: true }],
      sendMessage: (tabId, message) => dispatch(lists.content, message, `tab-${tabId}`),
    },
    scripting: { executeScript: async (details) => hooks.onExecute(details) },
  };

  return {
    chrome, data, sent, hooks,
    registerAs: (who) => { registerAs = who; },
    resetContent: () => { lists.content.length = 0; },
    resetWorker: () => { lists.sw.length = 0; installed.length = 0; },
    fireInstalled: async () => { for (const fn of installed) await fn({ reason: 'install' }); },
    listenerCount: (who) => lists[who].length,
  };
}

/** Polls until `cond()` is truthy or the deadline passes (then throws with `what`). */
export async function until(cond, { ms = 4000, what = 'condition' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
