/**
 * Create a document-local controller driven by a shared absolute deadline.
 * @param {Function} setStatus Render this document's actual lock state.
 * @param {Function} onSchedule Refresh deadline-dependent UI on expiry.
 * @returns {{setDeadline: Function, start: Function}} Controller operations.
 */
export function createWakeController(setStatus, onSchedule) {
    /** Current document's lock sentinel. */
    let wakeLock = null;
    /** Single in-flight acquisition. */
    let requestPromise = null;
    /** Pending reconnect timeout. */
    let retryTimer = null;
    /** Absolute-deadline timeout. */
    let scheduleTimer = null;
    /** Applied epoch deadline, or null for unlimited operation. */
    let scheduledEndTime = null;
    /** Generation used to discard stale acquisitions. */
    let visibilityVersion = 0;
    /** Whether lifecycle listeners are installed and acquisition may begin. */
    let started = false;
    /**
     * @returns {boolean} Whether the deadline has passed.
     */
    function isScheduleExpired() {
        return scheduledEndTime !== null && Date.now() >= scheduledEndTime;
    }
    /**
     * @returns {boolean} Whether acquisition is allowed.
     */
    function shouldMaintainWakeLock() {
        return !isScheduleExpired();
    }
    /**
     * Record technical diagnostics.
     * @param {string} message Diagnostic description.
     * @param {unknown} [error] Optional failure details.
     */
    function log(message, error) {
        console.debug('[Screen Caffeine] ' + message, ...(error ? [error] : []));
    }
    /** Cancel the pending reconnect attempt. */
    function clearRetryTimer() {
        window.clearTimeout(retryTimer);
        retryTimer = null;
    }

    /** Cancel the pending deadline callback. */
    function clearScheduleTimer() {
        window.clearTimeout(scheduleTimer);
        scheduleTimer = null;
    }

    /**
     * Retry acquisition while visible and before the deadline.
     * @param {string} reason Diagnostic trigger.
     * @param {boolean} [keepError=false] Preserve the failure status.
     */
    function scheduleRetry(reason, keepError = false) {
        if (retryTimer !== null || document.visibilityState !== 'visible' ||
                !shouldMaintainWakeLock()) {
            return;
        }
        if (!keepError) {
            setStatus('waiting');
        }
        retryTimer = window.setTimeout(() => {
            retryTimer = null;
            requestWakeLock(reason, true);
        }, 1000);
    }

    /**
     * Detach and release this document lock.
     * @param {string} reason Diagnostic trigger.
     * @returns {Promise<void>} Release completion.
     */
    async function releaseWakeLock(reason) {
        /** Lock being released or newly acquired. */
        const sentinel = wakeLock;
        // Detach before awaiting so old release events cannot overwrite a new lock.
        wakeLock = null;
        if (!sentinel || sentinel.released) {
            return;
        }
        try {
            await sentinel.release();
            log('Wake lock released: ' + reason);
        } catch (error) {
            log('Wake lock release failed: ' + reason, error);
        }
    }

    /** Stop acquisition and refresh the UI on expiry. */
    function finishScheduledLock() {
        if (!isScheduleExpired()) {
            return;
        }
        clearScheduleTimer();
        clearRetryTimer();
        setStatus('ended');
        onSchedule();
        releaseWakeLock('timer ended');
    }

    /** Arm a bounded timeout for the absolute deadline. */
    function startScheduleTimer() {
        clearScheduleTimer();
        if (scheduledEndTime === null) {
            return;
        }
        if (isScheduleExpired()) {
            finishScheduledLock();
            return;
        }
        scheduleTimer = window.setTimeout(() => {
            scheduleTimer = null;
            startScheduleTimer();
        }, Math.min(scheduledEndTime - Date.now(), 24 * 60 * 60 * 1000));
    }

    /** Render expired, hidden, or unsupported states. */
    function syncInactiveStatus() {
        if (isScheduleExpired()) {
            finishScheduledLock();
        } else if (document.visibilityState !== 'visible') {
            setStatus('hidden');
        } else if (!('wakeLock' in navigator)) {
            setStatus('unsupported');
        }
    }

    /**
     * Acquire a lock and discard stale results.
     * @param {string} reason Diagnostic trigger.
     * @param {boolean} [retry=false] Render reconnecting.
     * @returns {Promise<void>} Acquisition completion.
     */
    async function requestWakeLock(reason, retry = false) {
        if (!shouldMaintainWakeLock() || document.visibilityState !== 'visible') {
            syncInactiveStatus();
            return;
        }
        if (!('wakeLock' in navigator)) {
            setStatus('unsupported');
            log('Screen Wake Lock API is not supported.');
            return;
        }
        if (wakeLock && !wakeLock.released) {
            setStatus('active');
            return;
        }
        if (requestPromise) {
            return requestPromise;
        }

        clearRetryTimer();
        setStatus(retry ? 'waiting' : 'requesting');
        /** Visibility generation captured before acquisition. */
        const requestVersion = visibilityVersion;
        // Defer acquisition so requestPromise is assigned even if the API throws.
        requestPromise = Promise.resolve().then(async () => {
            try {
                /** Lock being released or newly acquired. */
                const sentinel = await navigator.wakeLock.request('screen');
                if (requestVersion !== visibilityVersion ||
                        document.visibilityState !== 'visible' ||
                        !shouldMaintainWakeLock() || sentinel.released) {
                    await sentinel.release();
                    syncInactiveStatus();
                    if (document.visibilityState === 'visible' && shouldMaintainWakeLock()) {
                        scheduleRetry('discarded stale wake lock');
                    }
                    return;
                }

                wakeLock = sentinel;
                sentinel.addEventListener('release', () => {
                    if (wakeLock !== sentinel) {
                        return;
                    }
                    wakeLock = null;
                    log('Wake lock released by the browser.');
                    if (shouldMaintainWakeLock() && document.visibilityState === 'visible') {
                        scheduleRetry('browser release');
                    } else {
                        syncInactiveStatus();
                    }
                }, { once: true });
                setStatus('active');
                log('Wake lock acquired: ' + reason);
            } catch (error) {
                log('Wake lock request failed: ' + reason, error);
                if (!shouldMaintainWakeLock() || document.visibilityState !== 'visible') {
                    syncInactiveStatus();
                } else {
                    setStatus('error');
                    scheduleRetry('request failure', true);
                }
            } finally {
                requestPromise = null;
            }
        });
        return requestPromise;
    }

    /**
     * Apply a deadline without restarting its duration.
     * @param {number|null} deadline Epoch milliseconds or no limit.
     */
    function setDeadline(deadline) {
        scheduledEndTime = deadline;
        if (started) {
            startScheduleTimer();
            requestWakeLock('schedule synchronized');
        }
    }
    /** Update title and reconcile this document's lock. */
    function reconcileVisibility() {
        visibilityVersion += 1;
        document.title = document.visibilityState === 'visible'
            ? 'Screen Caffeine'
            : 'Wake Lock inactive — Screen Caffeine';
        if (document.visibilityState === 'visible') {
            startScheduleTimer();
            requestWakeLock('page visible');
        } else {
            clearRetryTimer();
            syncInactiveStatus();
            releaseWakeLock('page hidden');
        }
    }
    /** Attach lifecycle listeners and start acquisition. */
    function start() {
        if (started) {
            return;
        }
        started = true;
        document.addEventListener('visibilitychange', reconcileVisibility);
        window.addEventListener('pageshow', reconcileVisibility);
        window.addEventListener('pagehide', () => {
            visibilityVersion += 1;
            clearRetryTimer();
            clearScheduleTimer();
            releaseWakeLock('page leaving');
        });
        reconcileVisibility();
    }
    return { setDeadline, start };
}
