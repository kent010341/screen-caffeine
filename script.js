import { createWakeController } from '@screen-caffeine/wake-controller.js';
import { createSession } from '@screen-caffeine/session.js';
import { renderStatus } from '@screen-caffeine/status-view.js';
import { setupMiniButton } from '@screen-caffeine/window-navigation.js';

/** Collapsible timer editor. */
const timerSettings = document.getElementById('timer-settings');
/** Timer application form. */
const scheduleForm = document.getElementById('schedule-form');
/** Draft hours input. */
const hoursInput = document.getElementById('duration-hours');
/** Draft minutes input. */
const minutesInput = document.getElementById('duration-minutes');
/** Apply timer action. */
const applyButton = document.getElementById('apply-schedule');
/** Cancel timer action. */
const cancelButton = document.getElementById('cancel-schedule');
/** Conditional cancellation control. */
const cancelControl = document.getElementById('cancel-control');
/** Applied timer summary. */
const scheduleInfo = document.getElementById('schedule-info');
/** Unapplied draft notice. */
const pendingNotice = document.getElementById('schedule-pending');
/** Unapplied draft explanation. */
const pendingText = document.getElementById('pending-text');
/** Validation error notice. */
const errorNotice = document.getElementById('schedule-error');
/** Validation error explanation. */
const errorText = document.getElementById('error-text');

/** Shared session settings. */
const session = createSession();
/** Applied absolute deadline. */
let scheduledEndTime = session.getSettings().deadline;
/** Applied editor duration. */
let appliedDuration = session.getSettings().duration;
/** Whether the editor was visited or changed. */
let draftTouched = false;
/** Controller for this document's actual lock. */
const controller = createWakeController(renderStatus, () => {
    updateScheduleSummary();
    updateDraft();
});

/**
 * @returns {boolean} Whether the deadline has passed.
 */
function isScheduleExpired() {
    return scheduledEndTime !== null && Date.now() >= scheduledEndTime;
}

/**
 * Format the deadline in local time.
 * @param {number} timestamp Epoch milliseconds.
 * @returns {string} Local date and time.
 */
function formatLocalTime(timestamp) {
    return new Date(timestamp).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
    });
}

/**
 * Validate the timer draft.
 * @returns {{hours?: number, minutes?: number, error?: string}} Duration or error.
 */
function readDuration() {
    /** Parsed draft hours. */
    const hours = Number(hoursInput.value);
    /** Parsed draft minutes. */
    const minutes = Number(minutesInput.value);
    if (!hoursInput.validity.valid || !minutesInput.validity.valid ||
            !Number.isInteger(hours) || !Number.isInteger(minutes)) {
        return { error: 'Use whole hours (0–168) and minutes (0–59).' };
    }
    if (hours * 60 + minutes < 1) {
        return { error: 'Set at least one minute.' };
    }
    return { hours, minutes };
}

/** Refresh validation and unapplied draft notices. */
function updateDraft() {
    /** Validated editor draft. */
    const draft = readDuration();
    /** Whether application changes the active setting. */
    const changed = !appliedDuration ||
        draft.hours !== appliedDuration.hours ||
        draft.minutes !== appliedDuration.minutes ||
        isScheduleExpired();
    /** Whether a valid draft needs application. */
    const pending = draftTouched && !draft.error && changed;

    applyButton.disabled = Boolean(draft.error) || !changed;
    applyButton.dataset.pending = String(pending);
    pendingText.textContent = pending
        ? (scheduledEndTime === null
            ? 'Timer not applied. No time limit is active.'
            : 'Changes not applied.')
        : '';
    pendingNotice.hidden = !pending;
    errorText.textContent = draftTouched ? draft.error || '' : '';
    errorNotice.hidden = !errorText.textContent;

    /** Whether valid fields specify no duration. */
    const zeroDuration = !draft.error ? false :
        hoursInput.validity.valid && minutesInput.validity.valid &&
        Number(hoursInput.value) + Number(minutesInput.value) === 0;
    hoursInput.setAttribute('aria-invalid',
        String(draftTouched && (!hoursInput.validity.valid || zeroDuration)));
    minutesInput.setAttribute('aria-invalid',
        String(draftTouched && (!minutesInput.validity.valid || zeroDuration)));
}

/** Display the applied deadline. */
function updateScheduleSummary() {
    cancelControl.hidden = scheduledEndTime === null;
    scheduleInfo.textContent = scheduledEndTime === null
        ? 'No time limit'
        : isScheduleExpired()
            ? 'Timer ended'
            : 'Ends at ' + formatLocalTime(scheduledEndTime);
}

timerSettings.addEventListener('toggle', () => {
    if (timerSettings.open) {
        draftTouched = true;
        updateDraft();
    }
});

for (const input of [hoursInput, minutesInput]) {
    input.addEventListener('input', () => {
        draftTouched = true;
        updateDraft();
    });
}

scheduleForm.addEventListener('submit', event => {
    event.preventDefault();
    draftTouched = true;
    /** Validated editor draft. */
    const draft = readDuration();
    updateDraft();
    if (draft.error || applyButton.disabled) {
        return;
    }

    appliedDuration = { hours: draft.hours, minutes: draft.minutes };
    scheduledEndTime = Date.now() + (draft.hours * 60 + draft.minutes) * 60 * 1000;
    updateScheduleSummary();
    updateDraft();
    session.apply({ deadline: scheduledEndTime, duration: appliedDuration });
});

cancelButton.addEventListener('click', () => {
    scheduledEndTime = null;
    appliedDuration = null;
    // Reset the editor so cancelling does not immediately create a new reminder.
    hoursInput.value = '1';
    minutesInput.value = '0';
    draftTouched = false;
    timerSettings.open = false;
    updateScheduleSummary();
    updateDraft();
    timerSettings.querySelector('summary').focus();
    session.apply({ deadline: null, duration: null });
});

session.subscribe(settings => {
    scheduledEndTime = settings.deadline;
    appliedDuration = settings.duration;
    if (!draftTouched) {
        hoursInput.value = String(appliedDuration?.hours ?? 1);
        minutesInput.value = String(appliedDuration?.minutes ?? 0);
    }
    updateScheduleSummary();
    updateDraft();
    controller.setDeadline(scheduledEndTime);
});
setupMiniButton(session);
controller.start();
