/**
 * Validate persisted session settings before using them as a wake lock deadline.
 * @param {unknown} value Parsed storage value.
 * @returns {boolean} Whether the settings contain a consistent supported duration.
 */
function isSettings(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    if (value.deadline === null && value.duration === null) {
        return true;
    }
    /** Duration used to populate the full-page editor. */
    const duration = value.duration;
    return Number.isSafeInteger(value.deadline) && value.deadline > 0 && duration !== null &&
        typeof duration === 'object' && Number.isInteger(duration.hours) &&
        duration.hours >= 0 && duration.hours <= 168 && Number.isInteger(duration.minutes) &&
        duration.minutes >= 0 && duration.minutes <= 59 && duration.hours * 60 + duration.minutes >= 1;
}

/**
 * Join a URL-scoped session, retaining settings across reloads and opener closure.
 * @returns {{id: string, getSettings: Function, apply: Function, subscribe: Function}} Session operations.
 */
export function createSession() {
    /** Current URL carrying the shared session identity. */
    const url = new URL(window.location.href);
    /** Requested identity, accepted only in UUID format. */
    const requestedId = url.searchParams.get('session');
    /** Unique identity isolates unrelated full-page tabs. */
    const id = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestedId ?? '')
        ? requestedId : crypto.randomUUID();
    /** Session-specific persistent storage key. */
    const key = 'screen-caffeine:session:' + id;
    /** Consumers subscribed to applied settings. */
    const listeners = new Set();
    /** Last known valid settings, also used if storage is unavailable. */
    let settings = { deadline: null, duration: null };
    /** Cross-window channel complements storage notifications. */
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(key) : null;

    url.searchParams.set('session', id);
    window.history.replaceState(null, '', url);

    /** Refresh consumers after receiving a valid settings snapshot. */
    function notify() {
        for (const listener of listeners) {
            listener(settings);
        }
    }

    /** Read persisted settings without treating storage failure as an unlimited reset. */
    function readStorage() {
        try {
            /** Parsed snapshot; malformed or unrelated data must not affect acquisition. */
            const stored = JSON.parse(localStorage.getItem(key));
            if (isSettings(stored)) {
                settings = stored;
            }
        } catch (error) {
            console.debug('[Screen Caffeine] Session storage unavailable.', error);
        }
    }

    /**
     * Commit an applied setting, preserving its absolute deadline.
     * @param {{deadline: number|null, duration: object|null}} next Applied settings.
     */
    function apply(next) {
        if (!isSettings(next)) {
            throw new TypeError('Invalid timer settings.');
        }
        settings = structuredClone(next);
        try {
            localStorage.setItem(key, JSON.stringify(settings));
        } catch (error) {
            console.debug('[Screen Caffeine] Cannot persist timer settings.', error);
        }
        channel?.postMessage({ type: 'settings', settings });
        notify();
    }

    /**
     * Subscribe and immediately render the latest applied settings.
     * @param {Function} listener Applied-settings callback.
     */
    function subscribe(listener) {
        listeners.add(listener);
        listener(settings);
    }

    /**
     * @returns {object} A copy of the current applied setting.
     */
    function getSettings() {
        return structuredClone(settings);
    }

    readStorage();
    window.addEventListener('storage', event => {
        if (event.key === key) {
            readStorage();
            notify();
        }
    });
    window.addEventListener('pageshow', () => {
        readStorage();
        notify();
        channel?.postMessage({ type: 'request' });
    });
    if (channel) {
        channel.addEventListener('message', event => {
            if (event.data?.type === 'request') {
                readStorage();
                channel.postMessage({ type: 'settings', settings });
            } else if (event.data?.type === 'settings' && isSettings(event.data.settings)) {
                settings = structuredClone(event.data.settings);
                readStorage();
                notify();
            }
        });
        channel.postMessage({ type: 'request' });
    }
    return { id, getSettings, apply, subscribe };
}
