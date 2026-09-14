import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the popup prepares tabCapture before its first asynchronous click operation", () => {
  const source = readFileSync(new URL("../popup.js", import.meta.url), "utf8");
  const clickHandler = source.slice(source.indexOf('$("toggle").addEventListener'));
  const preparation = clickHandler.indexOf("const tabCapture = starting ? prepareTabCapture(tabId)");
  const firstAwait = clickHandler.indexOf("await chrome.storage.local.set");

  assert(preparation >= 0, "the click handler must prepare tab capture");
  assert(firstAwait >= 0, "the click handler must persist the user's settings");
  assert(preparation < firstAwait, "tabCapture must run while the popup click still has user activation");
  assert.match(clickHandler, /tabStreamId: preparedCapture\?\.tabStreamId/);
  assert.match(clickHandler, /tabCaptureError: preparedCapture\?\.tabCaptureError/);
});
