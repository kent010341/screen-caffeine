import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, SourceTextModule } from 'node:vm';

/**
 * Load a browser module in an isolated document with controllable time and locks.
 * @param {string} file Shared module resource inside lib/.
 * @param {object} [options] Initial clock, storage, and URL overrides.
 * @returns {Promise<object>} Module exports and observable browser state.
 */
async function environment(file, options = {}) {
    /** Deterministic epoch clock. */
    let now = options.now ?? 1000;
    /** Pending timeout callbacks keyed by handle. */
    const timers = new Map();
    /** Monotonic timeout handle. */
    let timerId = 0;
    /** Fake document supports real EventTarget lifecycle dispatch. */
    const document = new EventTarget();
    document.visibilityState = 'visible';
    /** Fake window captures browser lifecycle and navigation. */
    const window = new EventTarget();
    window.location = { href: options.url ?? 'https://example.test/app/' };
    window.history = {
        /**
         * Update the session URL without navigation.
         * @param {unknown} state History state.
         * @param {string} title Unused title.
         * @param {URL} url New URL.
         */
        replaceState(state, title, url) {
            window.location.href = String(url);
        }
    };
    /** @param {Function} callback Timeout action. @param {number} delay Milliseconds. @returns {number} Handle. */
    window.setTimeout = (callback, delay) => {
        timerId += 1;
        timers.set(timerId, { callback, at: now + delay });
        return timerId;
    };
    /** @param {number} id Timeout to cancel. */
    window.clearTimeout = id => {
        timers.delete(id);
    };
    /** Acquired sentinels expose their release events. */
    const locks = [];
    /** Number of browser acquisition requests. */
    let requests = 0;
    /** Switch to model system rejection. */
    let fail = false;
    /** Optional unresolved acquisition used to test stale results. */
    let deferred = null;
    /** Browser acquisition mock. */
    const navigator = {
        wakeLock: {
            /** @returns {Promise<EventTarget>} Newly acquired sentinel. */
            async request() {
                requests += 1;
                if (fail) {
                    throw new Error('System denied lock');
                }
                /** Sentinel with explicit release behavior. */
                const lock = new EventTarget();
                lock.released = false;
                /** @returns {Promise<void>} Release completion. */
                lock.release = async () => {
                    lock.released = true;
                    lock.dispatchEvent(new Event('release'));
                };
                locks.push(lock);
                if (deferred) {
                    await deferred;
                }
                return lock;
            }
        }
    };
    /** Persistent store shared by separate document environments. */
    const storage = options.storage ?? new Map();
    /** Browser globals for the isolated module. */
    const context = createContext({
        window, document, navigator, URL, Event, structuredClone,
        crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
        Date: { now: () => now },
        console: {
            /** Ignore diagnostics during deterministic tests. */
            debug() {
            }
        },
        localStorage: {
            /** @param {string} key Storage key. @returns {string|null} Saved snapshot. */
            getItem(key) {
                return storage.get(key) ?? null;
            },
            /** @param {string} key Storage key. @param {string} value Serialized snapshot. */
            setItem(key, value) {
                storage.set(key, value);
            }
        }
    });
    /** Module loaded as source so production import maps remain browser-native. */
    const module = new SourceTextModule(
        readFileSync(new URL('../lib/' + file, import.meta.url), 'utf8'), { context }
    );
    await module.link(() => {
        throw new Error('Unexpected module dependency');
    });
    await module.evaluate();

    /** Flush acquisition promise continuations. */
    async function settle() {
        for (let iteration = 0; iteration < 12; iteration += 1) {
            await Promise.resolve();
        }
    }

    /** @param {number} milliseconds Time to advance. @returns {Promise<void>} Callback completion. */
    async function advance(milliseconds) {
        now += milliseconds;
        for (const [id, timer] of [...timers]) {
            if (timer.at <= now) {
                timers.delete(id);
                timer.callback();
            }
        }
        await settle();
    }

    return {
        exports: module.namespace, window, document, navigator, locks, timers, storage, settle, advance,
        /** @returns {number} Total acquisition requests. */
        requests: () => requests,
        /** @param {boolean} value Whether acquisitions should fail. */
        setFailure(value) {
            fail = value;
        },
        /** @param {Promise<void>} value Pending acquisition gate. */
        defer(value) {
            deferred = value;
        }
    };
}

test('absolute deadline expires, stops retries, and cancellation reacquires', async () => {
    /** Isolated acquisition environment. */
    const env = await environment('wake-controller.js');
    /** Actual document statuses. */
    const states = [];
    /** Deadline refresh counter. */
    let expired = 0;
    /** Controller under test. */
    const controller = env.exports.createWakeController(state => states.push(state), () => {
        expired += 1;
    });
    controller.setDeadline(2000);
    controller.start();
    await env.settle();
    assert.equal(states.at(-1), 'active');
    await env.advance(1000);
    assert.equal(states.at(-1), 'ended');
    assert.equal(env.locks[0].released, true);
    assert.ok(expired > 0);
    await env.advance(5000);
    assert.equal(env.requests(), 1);
    controller.setDeadline(null);
    await env.settle();
    assert.equal(states.at(-1), 'active');
    assert.equal(env.requests(), 2);
});

test('hidden document releases and restores; browser releases retry', async () => {
    /** Independent document runtime. */
    const env = await environment('wake-controller.js');
    /** State transitions. */
    const states = [];
    /** Document controller. */
    const controller = env.exports.createWakeController(state => states.push(state), () => {
    });
    controller.start();
    await env.settle();
    env.document.visibilityState = 'hidden';
    env.document.dispatchEvent(new Event('visibilitychange'));
    await env.settle();
    assert.equal(states.at(-1), 'hidden');
    assert.equal(env.locks[0].released, true);
    env.document.visibilityState = 'visible';
    env.document.dispatchEvent(new Event('visibilitychange'));
    await env.settle();
    assert.equal(states.at(-1), 'active');
    await env.locks.at(-1).release();
    assert.equal(states.at(-1), 'waiting');
    await env.advance(1000);
    assert.equal(states.at(-1), 'active');
});

test('rejects stale in-flight locks and never retries after expiry', async () => {
    /** Runtime with an acquisition held in flight. */
    const env = await environment('wake-controller.js');
    /** Resolve the pending browser request. */
    let resolve;
    env.defer(new Promise(done => {
        resolve = done;
    }));
    /** Observable state transitions. */
    const states = [];
    /** Controller with a short absolute deadline. */
    const controller = env.exports.createWakeController(state => states.push(state), () => {
    });
    controller.setDeadline(1500);
    controller.start();
    await env.settle();
    await env.advance(500);
    resolve();
    await env.settle();
    assert.equal(env.locks[0].released, true);
    assert.equal(states.at(-1), 'ended');
    assert.equal(env.timers.size, 0);
});

test('unsupported and system-denied locks retain readable states', async () => {
    /** Runtime without API support. */
    const unsupported = await environment('wake-controller.js');
    delete unsupported.navigator.wakeLock;
    /** Unsupported state history. */
    const states = [];
    unsupported.exports.createWakeController(state => states.push(state), () => {
    }).start();
    await unsupported.settle();
    assert.equal(states.at(-1), 'unsupported');
    /** Runtime modeling a system denial. */
    const denied = await environment('wake-controller.js');
    denied.setFailure(true);
    denied.exports.createWakeController(state => states.push(state), () => {
    }).start();
    await denied.settle();
    assert.equal(states.at(-1), 'error');
    assert.equal(denied.timers.size, 1);
});

test('documents maintain independent lock states and stop at the same shared deadline', async () => {
    /** Original full-page runtime. */
    const full = await environment('wake-controller.js');
    /** Mini document with its own independent browser lock. */
    const mini = await environment('wake-controller.js');
    /** Full-page state history. */
    const fullStates = [];
    /** Mini-page state history. */
    const miniStates = [];
    /** Full-page controller. */
    const fullController = full.exports.createWakeController(state => fullStates.push(state), () => {
    });
    /** Mini-page controller. */
    const miniController = mini.exports.createWakeController(state => miniStates.push(state), () => {
    });
    fullController.setDeadline(2000);
    miniController.setDeadline(2000);
    fullController.start();
    miniController.start();
    await Promise.all([full.settle(), mini.settle()]);
    full.document.visibilityState = 'hidden';
    full.document.dispatchEvent(new Event('visibilitychange'));
    await full.settle();
    assert.equal(fullStates.at(-1), 'hidden');
    assert.equal(miniStates.at(-1), 'active');
    assert.equal(mini.locks[0].released, false);
    await Promise.all([full.advance(1000), mini.advance(1000)]);
    assert.equal(fullStates.at(-1), 'ended');
    assert.equal(miniStates.at(-1), 'ended');
    assert.equal(mini.locks[0].released, true);
});

test('shared settings restore exact deadlines and synchronize cancellation through storage', async () => {
    /** Shared same-origin persistence. */
    const storage = new Map();
    /** Original full page session. */
    const full = await environment('session.js', { storage });
    /** Original session operations. */
    const session = full.exports.createSession();
    session.apply({ deadline: 61000, duration: { hours: 0, minutes: 1 } });
    /** Mini window loaded later with the same URL identity. */
    const mini = await environment('session.js', { storage, url: full.window.location.href, now: 30000 });
    /** Independently initialized mini session. */
    const miniSession = mini.exports.createSession();
    assert.equal(miniSession.getSettings().deadline, 61000);
    full.window.dispatchEvent(new Event('pagehide'));
    assert.equal(miniSession.getSettings().deadline, 61000);
    session.apply({ deadline: null, duration: null });
    /** Browser storage event notifying the mini document. */
    const changed = new Event('storage');
    changed.key = 'screen-caffeine:session:' + session.id;
    mini.window.dispatchEvent(changed);
    assert.equal(miniSession.getSettings().deadline, null);
    assert.throws(() => session.apply({ deadline: 123, duration: { hours: 0, minutes: 0 } }), /Invalid/);
});

test('popup button reuses window and displays blockers without touching session settings', async () => {
    /** Navigation runtime. */
    const env = await environment('window-navigation.js');
    /** Button event target and independently controlled feedback. */
    const button = new EventTarget();
    /** Popup feedback visibility. */
    const notice = { hidden: true };
    env.document.getElementById = id => id === 'open-mini' ? button : notice;
    /** Captured open calls and focus count. */
    const calls = [];
    /** Reusable mini window. */
    const popup = {
        closed: false,
        /** Model a focusable browser window. */
        focus() {
        }
    };
    env.window.open = (...args) => {
        calls.push(args);
        return popup;
    };
    env.exports.setupMiniButton({ id: 'example' });
    button.dispatchEvent(new Event('click'));
    button.dispatchEvent(new Event('click'));
    assert.equal(calls.length, 1);
    assert.match(calls[0][0].href, /mini.html\?session=example$/);
    assert.equal(calls[0][2], 'popup,width=280,height=240');
    popup.closed = true;
    env.window.open = () => null;
    button.dispatchEvent(new Event('click'));
    assert.equal(notice.hidden, false);
});

test('return link focuses a matching opener and falls back after closure', async () => {
    /** Mini navigation runtime. */
    const env = await environment('window-navigation.js');
    /** Native link event target. */
    const link = new EventTarget();
    env.document.getElementById = () => link;
    /** Focus calls to original full page. */
    let focused = 0;
    env.window.opener = {
        closed: false,
        location: { origin: 'https://example.test', href: 'https://example.test/app/?session=example' },
        /** Count focus requests to the original full page. */
        focus() {
            focused += 1;
        }
    };
    env.window.location.origin = 'https://example.test';
    env.exports.setupFullPageLink({ id: 'example' });
    /** Cancelable click intercepted for a valid opener. */
    const first = new Event('click', { cancelable: true });
    link.dispatchEvent(first);
    assert.equal(first.defaultPrevented, true);
    assert.equal(focused, 1);
    env.window.opener.closed = true;
    /** Native fallback click opens the session-preserving URL. */
    const fallback = new Event('click', { cancelable: true });
    link.dispatchEvent(fallback);
    assert.equal(fallback.defaultPrevented, false);
    assert.match(link.href, /index.html\?session=example$/);
});
