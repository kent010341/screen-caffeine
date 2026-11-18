# Screen Caffeine

Keeps the screen awake via the Screen Wake Lock API. The page requests the lock automatically; the user's intended action is **doing nothing**.

## Principles

- The core CTA is "do nothing". The UI must stay minimal: no flashy effects, extra decoration, or attention-grabbing elements. Prefer plain text notices over new widgets.
- Pure HTML / JS / CSS, lightweight. No build step, no dependencies, no framework. ES modules + import map only.
- Errors and states stay visible as text (accessible); respect `prefers-reduced-motion`.

## Structure

- `index.html`, `script.js`, `styles.css` - full page: status, optional timer, mini window button, notices.
- `mini.html`, `mini.js`, `mini.css` - compact popup (280x240): status + remaining time + "Open full page" link.
- `lib/` (import map alias `@screen-caffeine/` -> `./lib/`):
  - `wake-controller.js` - per-document wake lock, retries every 1s while visible, stops at the deadline.
  - `session.js` - shared session: `?session=<uuid>` in the URL, localStorage + BroadcastChannel sync of the absolute `deadline` and `duration`.
  - `status-view.js` - renders wake lock state.
  - `window-navigation.js` - popup opening (`parsePopupParam`, `popupFeatures`, `setupMiniButton`) and the return-to-full-page link.
- `assets/icons/` - local Lucide SVGs. `favicon.svg`, `sanufist.jpg` - favicon and background.
- `tests/behavior.test.mjs` - Node built-in tests with browser mocks. Run:
  `node --experimental-vm-modules --test --test-isolation=none tests/behavior.test.mjs`

## Behavior notes

- Each visible document holds its own wake lock; hidden or minimized documents lose it. The timer is an absolute deadline shared across windows of the same session.
- Popup: opened with `window.open` using one named window per session. Always bottom-left: features use `left=0,top=99999` and rely on the browser clamping the window into a screen. Do not compute positions from `screen.availLeft/availTop` (they are 0 on secondary screens in Firefox) and do not add alignment options.
- Which screen the popup lands on is browser behavior (Firefox: primary, Chrome/Edge: opener's screen); this is accepted, not worked around.
- `?popup` (presence only, value ignored) auto-opens the popup on load.
- Auto-open has no user gesture, so browsers may block it; the existing `#popup-notice` text is then shown.
- While the popup is open the full page shows `#close-hint` ("Mini window is running. You can close this page."), hidden again when the popup closes. Scripts cannot close a tab they did not open, so this is only a hint.
- Only `session` is preserved in the URL by `replaceState`; other params such as `popup` stay intact.
