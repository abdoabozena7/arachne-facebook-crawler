# ARACHNE — local visual crawler

A visible Playwright Chromium browser with a living Canvas spider, beside a small white collection panel. Paste a Facebook post link and press **Start**. Comments are selected automatically. The panel uses black text with different weights and displays actual saved comments. Collection effects occur only after genuine extraction and persistence.

The current workflow uses **fresh Chromium and public access only**. It scrolls the actual comment pane and uses supported visible load-more-comments controls. It does not open your Chrome profile, reuse saved passwords, install an extension, or ask you to sign in. If Facebook requires authentication, collection stops with an explicit reason. Chromium stays open for viewing until the next run or server shutdown. JSON exports and event logs remain available even for an empty run.

The reference images guided the sparse jointed neon spider, highlight bars and moving text fragments on the actual Facebook page. The white panel has one link field, one Start/Stop button and a plain collection list. Logs remain saved locally.

## Install and launch

On Windows, double-click **`run.cmd`** in this project folder. It prepares missing Node.js, dependencies and Chromium automatically, builds the app and opens the panel. Paste a post link and press Start. First-time downloads need internet access; subsequent launches reuse installed components. Portable Node.js downloads come from the official distribution and are checked against its published SHA-256 checksum. No administrator installation is required.

Repeated launches reopen the existing panel without starting another server. Source changes are rebuilt automatically. Active collections are preserved; updates apply on the next launch after collection finishes. Launcher caches and server logs are in `.runtime/`. Launch/reuse was tested on this machine with its existing dependencies; the missing-runtime download path has not been tested on a fresh machine.

For development, the equivalent manual commands require Node.js 22 or later and a graphical desktop:

```powershell
npm ci
npm run install:browser
npm run build
npm start
```

The white panel opens at **http://127.0.0.1:4318** in a narrow Chromium window on the left. Start opens the source alongside it on the right. The app positions only its own temporary browser windows. With `--no-open`, position your manually opened panel yourself.

```powershell
npm run dev                         # build and start after changes
npm start -- --no-open               # server only
npm start -- --port=4319             # alternate port
Copy-Item config.example.json config.json
```

`config.json` accepts `port`, `openDashboard`, `runsDir`, and `defaults`. Live defaults: Comments, publicOnly=true, visibleOnly=false, keepBrowserOpen=true, 200-item maximum, **0.85× animation with a brief focus pause for each comment**, video/screenshots off. Animation speed is 0.25–3×. Optional operation delay is 0–30,000 ms. Before extraction, each observed element stays focused for 1,600 ms divided by animation speed (about 1.9 seconds at 0.85×). This interruptible pause makes individual comments visible; there is no additional default operation delay after saving. A short wait after scrolling lets new content load. The item maximum is a ceiling, not a promise that many items are visible.

## Collect comments

Paste the post link and press **Start**. Comments are selected automatically. There is no sign-in, mode selection or confirmation checkbox. The button changes to **Stop** while running, and saved comments appear directly below. Each comment has its source link; **Save JSON** appears once records exist. Opening the panel starts with an empty collection. Stored runs remain on disk and are not automatically loaded into the list. Reopening during an active crawl shows its current progress; reconnecting the same panel keeps that session.

Newest records appear at the top. Each genuine saved record slides in while existing visible rows move down smoothly and the counter pulses. Burst arrivals retarget ongoing motion; reconnected active sessions do not replay effects. Reduced-motion preferences disable these animations. JSON and event journals retain capture order. The spider remains within the source window; drawing continuously across separate windows would require a native desktop overlay, which is outside this browser application.

Normal runs scroll the comment pane to discover further exposed comments and click supported visible load-more controls. They stop at the item limit or after bounded rounds without new records. Collapsed replies and text expansion are not opened. Starting another run closes the previous source viewer. Pacing, post limits and optional evidence remain configurable through `config.json` and the API rather than interface controls.

Compare saved text with the source alongside the panel and follow its comment links. A non-blocking login banner beside public comments is accepted. An enforced gate stops collection explicitly; missing comment layout is not treated as proof of a login requirement when a public photo is still exposed. Nothing substitutes for unavailable data. The source window remains open for viewing.

Screenshots are optional crops of accepted records. Public-only video is disabled. JSON, JSONL and event logs are always saved; no passwords, cookies or tokens are exported.

## Controlled fixture

Open `http://127.0.0.1:4318/?fixture=comments` and press Start for a clearly labeled local comment test. Its separate `/fixture?target=comments` source yields four saved comments and one duplicate. Equal text with distinct IDs remains separate. Fixture mode scrolls the controlled feed and closes its source when finished.

The post fixture is available using `?fixture=posts` for development; its full run yields five saved posts and one duplicate. Test expectations are never inserted as dashboard counts. Every fixture page and record is labeled as test data. Pause/resume and advanced evidence settings are exercised through the API in automated tests. Fixture recording can be enabled in configuration.

Use `/?fixture=comments&scroll=1` for the independent scrolling-pane fixture. It reveals eight comments progressively; its visible load-more button inserts four more. Automated verification checks all 12 real fixture records, measured pane movement, load-more, export and bounded completion with the default focus pause and zero additional operation delay. This is clearly labeled test data.

## Evidence and authenticity

Run results, recordings, screenshots, runtime caches and local configuration stay on the machine and are excluded from Git. The example run/output paths below describe validation performed during development; those generated files are not included in the repository.

```text
runs/<UTC timestamp>-<random suffix>/
  data.jsonl          # immediate fsync-ed record journal
  data.json           # atomically refreshed export after each save
  events.jsonl        # ordered timestamped observations and outcomes
  manifest.json       # source, settings, counters, outcome, evidence status
  summary.md          # readable result and limitations
  screenshots/       # optional accepted-record crops
  session.webm       # only when enabled and finalized
```

Match `element_id` across discovery, focus, extraction and save events; match `record_id` between saved events and JSON records. Records retain run ID, source URL, permalink or observed-element reference, capture time, actual visible text, nullable fields and extraction diagnostics. Comments add `record_type`, `comment_id` and `parent_post_url`; deduplication uses comment identity rather than the parent's post ID. Similar text is never assumed to be a duplicate.

The manifest reports unavailable/disabled video and the retained viewer. Archive downloads survive server restarts. Already flushed records survive forced termination, although the final manifest/video can remain incomplete. Automatic interrupted-run recovery is not implemented. Review visible source evidence before sharing.

A genuinely produced headed **fixture-only** example is `runs/2026-10-14T16-00-15-353Z-302eab54/`: five records, 39 events, three source crops and a finalized video. Its temporary validation server is closed; the normal fixture contains the same source text. Example actual extracted fields:

```json
{
  "post_id": "fixture-001",
  "text": "Morning field note: the river sensor recorded a change in water temperature. This sentence is visible source text from a controlled local fixture.",
  "published_at": "2026-10-01T08:30:00.000Z",
  "reaction_count": 23,
  "comment_count": 4,
  "share_count": 2,
  "source_mode": "fixture"
}
```

This is an excerpt from fixture extraction, not a Facebook result.

## Tests and live validation status

```powershell
npm test
npm run test:headed
```

The 22 automated tests cover real controlled DOM extraction, hidden/null fields, multiple adapter strategies, Arabic comments and emojis, genuine encoded comment identities, reference deduplication, durable storage/export, event ordering/counters, animation mapping, alternating leg steps with planted feet and articulated knees, pause/resume/stop, bounded feed exhaustion, public comments alongside a non-blocking login banner, enforced login-modal stopping, visible-only collection without scrolling, retained-window cleanup, browser closure, and opt-in evidence. Strict TypeScript checking runs during build.

Headed UI validation exercises the single Start/Stop button, side-by-side window placement, white theme and black text, genuine fixture comment arrivals, source links, JSON download, visible errors and mobile layout. It writes `output/playwright/simple-validation.json`, screenshots and genuine fixture evidence. Integration tests use temporary directories; UI validation deliberately preserves examples under `runs/`.

**Live public comment extraction succeeded on your selected photo URL in fresh anonymous Chromium.** Three genuine visible comments were saved, with Arabic text and emojis, source references, event logs and source crops. No sign-in was performed. `output/public-validation.json` records the reviewed run and its evidence location. The initial zero-record attempt incorrectly treated a non-blocking login banner as an enforced gate; the detector was corrected and regression-tested. Its old event log remains historical evidence, not proof that this post requires authentication. Earlier signed-in Chrome observations in `output/live-validation.json` are separate from the successful anonymous application crawl. A subsequent anonymous scrolling run (`runs/2026-10-14T20-04-01-962Z-e7eeeb51/`) saved 40 real comments beyond the initial viewport. It logged one failed extraction separately. This does not prove complete collection of all comments or other Facebook layouts. To verify your source: double-click run.cmd, paste the link, press Start, compare arriving records against Chromium, then follow a source link or save JSON.

## Design and known limits

The pipeline is **observation → discovery → focus → extraction → validation → persistence → animation**. Node HTTP and SSE provide the local APIs without a framework, database or cloud service. Events are serialized and logged before delivery. Renderer errors cannot fabricate records or prevent storage. Canvas springs move the graph. Eight legs alternate between two groups; their feet stay planted in page coordinates while the body advances, then lift and replant. Two-bone inverse kinematics produces bending knees, and the body turns toward its travel direction. Movement speed is capped so it walks between observed elements. Pointer-transparent Shadow DOM overlays and temporary Web Animations highlight real fields without replacing source content. Scrolling, resizing, device-pixel ratio and disconnected nodes are handled. A steady 60 FPS is a target, not a measured guarantee.

Responsibilities are separated across `src/server.ts`, `crawler.ts`, `state.ts`, `browser-controller.ts`, `adapter.ts`, `browser/dom.ts`, `records.ts`, `events.ts`, `storage.ts`, `browser/gait.ts`, `browser/network.ts`, `browser/overlay.ts` and `dashboard.ts`. `public/` contains the dashboard/fixture; `scripts/` and `tests/` contain validation. The older optional `companion/` and `bridge.ts` implementation remains for compatibility tests; it is not selected or installed by the dashboard.

Post discovery combines top-level articles, feed units and permalink ancestors. Comments use semantic comment/reply labels and comment permalinks. Comment text prefers elements with their own language attribute, excluding author links and relative-age labels. Logged-out author links can contain genuine encoded comment IDs; recognized `comment:<id>` and `comment:<parent>_<id>` values are decoded and attached to the observed parent post URL. Unknown identities remain opaque rather than guessed. Only exposed text nodes intersecting the viewport are extracted; hit-testing excludes content covered by modals/banners. See more is not clicked; `diagnostic.truncated` records expansion controls. Partial text is possible.

Unavailable dates and metrics are null. Relative dates, abbreviated counts, ambiguous localization, image text and inferred values are not guessed. Dates without a timezone retain their original form. Missing permalinks use weaker document-scoped observed-element references; recreated elements can then produce repeats.

Facebook DOM/languages/filters and consent screens change. Public content may expose no supported comments. Explicit diagnostics include login required, access denied, unsupported layout, content not loaded, missing selector, removed node, duplicate, no more progress, changed source navigation and unexpected browser closure. Opening another source during a run ends collection; start a new run for that URL. Filters and collapsed replies prevent a completeness guarantee.

The server binds to loopback and checks Host/Origin; live URLs must be HTTPS Facebook URLs without credentials. No CAPTCHA bypass, authentication bypass, evasion, proxies, hidden API harvesting or wider Facebook traversal is implemented. For Chromium launch failures run `npm run install:browser` and use a graphical desktop. For empty output inspect the manifest and events before changing selectors.
