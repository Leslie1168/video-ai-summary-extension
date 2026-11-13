// URL-scoped text-page memory. Keep the query string (different posts may use it),
// but discard the fragment so jumping to an in-page heading does not reset the chat.
export function pageKey(rawUrl) {
  const url = new URL(rawUrl);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported page URL');
  url.hash = '';
  return url.href;
}
export function createSessionStore(storage) {
  const prefix = 'reader-page:v1:';
  let writes = Promise.resolve();
  return {
    async load(url) {
      await writes.catch(() => {});
      const identity = pageKey(url), key = prefix + identity;
      const record = (await storage.get(key))[key];
      return record?.url === identity ? structuredClone(record) : null;
    },
    save(url, state) {
      const identity = pageKey(url), key = prefix + identity;
      // Capture immediately: a later tab switch must never mutate an earlier write.
      const record = structuredClone({...state, version:1, url:identity, updated:Date.now()});
      const next = writes.catch(() => {}).then(() => storage.set({[key]:record}));
      writes = next;
      return next;
    },
    flush() { return writes; },
  };
}
