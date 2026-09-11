import assert from "node:assert/strict";

export async function listAllTools(fetchPage, { forTool } = {}) {
  const tools = [];
  const seen = new Set();
  let cursor, preferredCursor, foundPreferred = false, lastPage;
  do {
    lastPage = await fetchPage(cursor);
    tools.push(...lastPage.tools);
    if (forTool && lastPage.tools.some((tool) => tool.name === forTool)) {
      preferredCursor = cursor;
      foundPreferred = true;
    }
    cursor = lastPage.nextCursor;
    if (cursor !== undefined) {
      assert.notEqual(lastPage.tools.length, 0, "A discovery page with a cursor must make progress");
      assert.equal(seen.has(cursor), false, "Discovery must not repeat a cursor");
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  // Pinned SDK listTools caches only the latest page. Re-fetch the consumer's
  // target page through the public API when client-side validation matters.
  if (foundPreferred && !lastPage.tools.some((tool) => tool.name === forTool)) await fetchPage(preferredCursor);
  return { tools };
}
