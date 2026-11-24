const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
function contentSource() {
  // Expose the real implementation only inside the test runtime, before init.
  return fs.readFileSync(path.join(root, "src/content.js"), "utf8").replace(
    "  globalThis.__feedLensTryInit = init;",
    "  globalThis.probe = { state, absoluteUrl, absoluteUrlFor, safeHtml, parseFeed, parseOpml, render, renderOpml, readerBypassUrl, customSubscribeUrl, renderFeedUrl }; return;"
  );
}

test("content URLs reject executable schemes, remote-to-file links and URL credentials", () => {
  const context = { URL, location: { href: "https://feed.test/rss" } };
  vm.createContext(context);
  vm.runInContext(contentSource(), context);
  for (const url of ["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,attack", "file:///tmp/feed.xml", "chrome://settings", "https://user:password@example.test/rss"]) {
    assert.equal(context.probe.absoluteUrl(url), "", url);
    assert.equal(context.probe.readerBypassUrl(url), "", url);
  }
  assert.equal(context.probe.absoluteUrl("/article"), "https://feed.test/article");
  context.probe.state.sourceUrl = "file:///tmp/list.opml";
  assert.equal(context.probe.absoluteUrl("./feed.xml"), "file:///tmp/feed.xml");
});

test("custom reader rejects executable templates without storing them", () => {
  let stored = false;
  let template = "javascript:alert('%s')";
  const context = {
    URL, location: { href: "https://feed.test/rss" },
    localStorage: { getItem: () => "", setItem: () => { stored = true; } },
    window: { prompt: () => template }
  };
  vm.createContext(context);
  vm.runInContext(contentSource(), context);
  assert.equal(context.probe.customSubscribeUrl("https://feed.test/rss"), "");
  assert.equal(stored, false);
  template = "https://reader.test/subscribe?feed=%s";
  assert.equal(context.probe.customSubscribeUrl("https://feed.test/rss"), "https://reader.test/subscribe?feed=https%3A%2F%2Ffeed.test%2Frss");
  assert.equal(stored, true);
});

test("reader rejects unsupported fetch schemes before issuing a request", async () => {
  let requests = 0;
  const context = { URL, location: { href: "https://feed.test/rss" }, fetch: () => { requests++; } };
  vm.createContext(context);
  vm.runInContext(contentSource(), context);
  for (const url of ["data:text/xml,<rss/>", "javascript:alert(1)", "chrome://settings", "https://user:password@example.test/rss"]) {
    await assert.rejects(context.probe.renderFeedUrl(url), /Unsupported feed URL/);
  }
  assert.equal(requests, 0);
});

test("normal web and explicitly permitted local previews retain credential-free fetching", async () => {
  const requests = [];
  const context = {
    URL, location: { href: "https://feed.test/rss" },
    FeedLensFileAccess: { isLocalFileUrl: u => u.startsWith("file:"), getFileSchemeAccessState: async () => true },
    fetch: async (url, options) => { requests.push({ url, options }); throw new Error("fixture request reached"); }
  };
  vm.createContext(context);
  vm.runInContext(contentSource(), context);
  for (const url of ["http://feed.test/rss", "https://feed.test/rss", "file:///tmp/fixture.opml"]) {
    await assert.rejects(context.probe.renderFeedUrl(url), /fixture request reached/);
  }
  assert.equal(requests.length, 3);
  assert(requests.every(request => request.options.credentials === "omit"));
});

test("background confines messages to own top frame and web feeds; settings are reader-only", async () => {
  let listener;
  const opened = [];
  const event = { addListener() {} };
  const chrome = {
    runtime: { id: "test", getURL: p => `chrome-extension://test/${p}`, onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { onUpdated: event, onRemoved: event, create: async p => opened.push(p), update: async (id, p) => opened.push(p) },
    webRequest: { onHeadersReceived: event }, action: { onClicked: event }
  };
  const context = { chrome, URL, console, FeedLensFileAccess: { extensionSettingsUrl: () => "chrome://extensions/?id=test" } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "src/background.js"), "utf8"), context);
  const sender = { id: "test", frameId: 0, tab: { id: 0 }, url: "https://site.test/" };
  const msg = feedUrl => ({ type: "FEEDLENS_OPEN_DISCOVERED_FEED", feedUrl });
  for (const url of ["file:///tmp/feed.xml", "javascript:alert(1)", "data:text/xml,<rss/>", "https://u:p@site.test/rss"]) listener(msg(url), sender, () => {});
  listener(msg("https://site.test/rss"), { ...sender, id: "foreign" }, () => {});
  listener(msg("https://site.test/rss"), { ...sender, frameId: 1 }, () => {});
  listener({ type: "FEEDLENS_OPEN_FILE_ACCESS_SETTINGS" }, sender, () => {});
  assert.equal(opened.length, 0);
  listener(msg("https://site.test/rss"), sender, () => {});
  assert.equal(opened.length, 1);
  listener({ type: "FEEDLENS_OPEN_FILE_ACCESS_SETTINGS" }, { ...sender, url: "chrome-extension://test/src/reader.html?feed=file%3A" }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.length, 2);
  assert.equal(opened[1].url, "chrome://extensions/?id=test");
});

test("canonical feed metadata cannot advertise executable/local URLs", () => {
  const { isCanonicalFeedLink } = require("../src/feed-discovery.js");
  for (const href of ["javascript:alert(1)", "file:///tmp/feed.xml", "data:text/xml,<rss/>", "https://u:p@site.test/rss"]) {
    assert.equal(isCanonicalFeedLink({ rel: "alternate", type: "application/rss+xml", href }), false);
  }
});

const chromePath = process.env.FEEDLENS_CHROME;
test("real browser sanitizes and renders hostile RSS/OPML while preserving normal flows", { skip: !chromePath }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feedlens-security-"));
  const harness = `<!doctype html><html><body><script>
    globalThis.chrome = {runtime:{getURL:p=>'file://${root}/'+p}};
    ${contentSource()}
  </script><script src="file://${root}/vendor/purify.min.js"></script><script>
    const checks = [];
    function check(value, label) { if (!value) throw new Error(label); checks.push(label); }
    try {
      probe.state.sourceUrl = 'https://feed.test/rss';
      const evil = '<a href="javascript:alert(1)">link</a><img src="file:///tmp/private.png" onerror="alert(1)"><script>alert(1)<'+ '/script>';
      const clean = probe.safeHtml(evil);
      check(!/javascript:|file:|onerror|<script/i.test(clean), 'article sanitization');
      globalThis.DOMPurify = undefined;
      check(!/<[a-z]/i.test(probe.safeHtml(evil)), 'missing sanitizer fails closed');
      const xml = new DOMParser().parseFromString('<rss><channel><title>Security fixture</title><link>javascript:alert(1)</link><item><title>Article</title><link>data:text/html,attack</link><description>Preview text</description></item></channel></rss>', 'text/xml');
      probe.state.feed = probe.parseFeed(xml, 'https://feed.test/rss');
      probe.render();
      check(document.title === 'Security fixture - FeedLens', 'reader identity');
      check(document.querySelector('.br-content').textContent.includes('Preview text'), 'RSS preview');
      check(!document.querySelector('.br-read-original'), 'unsafe original link omitted');
      document.querySelector('.br-subscribe-toggle').click();
      check(document.querySelector('.br-subscribe-toggle').getAttribute('aria-expanded') === 'true', 'subscribe interaction');
      const opml = new DOMParser().parseFromString('<opml><head><title>List</title></head><body><outline text="Bad" xmlUrl="javascript:alert(1)" htmlUrl="file:///tmp/private"/><outline text="Good" xmlUrl="https://feed.test/good.xml"/></body></opml>', 'text/xml');
      probe.state.opml = probe.parseOpml(opml, 'https://feed.test/list.opml');
      probe.renderOpml();
      check(![...document.querySelectorAll('a')].some(a=>/^(javascript|file|data):/i.test(a.getAttribute('href')||'')), 'OPML links filtered');
      check(document.body.textContent.includes('Good'), 'normal OPML retained');
      document.body.innerHTML = '<pre id="result">' + JSON.stringify({ok:true, checks}) + '</pre>';
    } catch (error) { document.body.innerHTML = '<pre id="result">' + JSON.stringify({ok:false, error:String(error)}) + '</pre>'; }
  </script></body></html>`;
  fs.writeFileSync(path.join(dir, "test.html"), harness);
  try {
    const result = spawnSync(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--allow-file-access-from-files", `--user-data-dir=${dir}/profile`, "--dump-dom", `file://${dir}/test.html`], { encoding: "utf8", timeout: 30000, maxBuffer: 2e6 });
    assert.equal(result.status, 0, result.error?.message || result.signal || result.stderr.slice(-2000));
    const match = result.stdout.match(/<pre id="result">(.*?)<\/pre>/s);
    assert(match, "Browser harness did not return a result");
    const data = JSON.parse(match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    assert.equal(data.ok, true, data.error);
    assert.equal(data.checks.length, 8);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
