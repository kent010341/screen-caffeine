const statusPanel = document.getElementById("wake-status");
const statusElement = document.getElementById("status");
const statusIcon = document.getElementById("status-icon");
const timerSettings = document.getElementById("timer-settings");
const scheduleForm = document.getElementById("schedule-form");
const hoursInput = document.getElementById("duration-hours");
const minutesInput = document.getElementById("duration-minutes");
const applyButton = document.getElementById("apply-schedule");
const cancelButton = document.getElementById("cancel-schedule");
const cancelControl = document.getElementById("cancel-control");
const scheduleInfo = document.getElementById("schedule-info");
const pendingNotice = document.getElementById("schedule-pending");
const pendingText = document.getElementById("pending-text");
const errorNotice = document.getElementById("schedule-error");
const errorText = document.getElementById("error-text");

let wakeLock = null;
let requestPromise = null;
let retryTimer = null;
let scheduleTimer = null;
let scheduledEndTime = null;
let appliedDuration = null;
let draftTouched = false;
let visibilityVersion = 0;

const statuses = {
  active: ["Screen kept awake", "monitor"],
  requesting: ["Starting…", "clock"],
  waiting: ["Reconnecting…", "clock"],
  hidden: ["Paused", "monitor-off"],
  ended: ["Timer ended", "clock"],
  error: ["Unable to keep screen awake", "triangle-alert"],
  unsupported: ["Wake lock unavailable", "triangle-alert"]
};

function setStatus(state) {
  const [text, icon] = statuses[state];
  statusPanel.dataset.state = state;
  statusElement.textContent = text;
  statusIcon.className = "icon icon-" + icon;
}

function log(message, error) {
  console.debug("[Screen Caffeine] " + message, ...(error ? [error] : []));
}

function updateTitle() {
  document.title = document.visibilityState === "visible"
    ? "Screen Caffeine"
    : "Wake Lock inactive — Screen Caffeine";
}

function isScheduleExpired() {
  return scheduledEndTime !== null && Date.now() >= scheduledEndTime;
}

function shouldMaintainWakeLock() {
  return scheduledEndTime === null || !isScheduleExpired();
}

function formatLocalTime(timestamp) {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function readDuration() {
  const hours = Number(hoursInput.value);
  const minutes = Number(minutesInput.value);
  if (!hoursInput.validity.valid || !minutesInput.validity.valid ||
      !Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return { error: "Use whole hours (0–168) and minutes (0–59)." };
  }
  if (hours * 60 + minutes < 1) {
    return { error: "Set at least one minute." };
  }
  return { hours, minutes };
}

function updateDraft() {
  const draft = readDuration();
  const changed = !appliedDuration ||
    draft.hours !== appliedDuration.hours ||
    draft.minutes !== appliedDuration.minutes ||
    isScheduleExpired();
  const pending = draftTouched && !draft.error && changed;

  applyButton.disabled = Boolean(draft.error) || !changed;
  applyButton.dataset.pending = String(pending);
  pendingText.textContent = pending
    ? (scheduledEndTime === null
      ? "Timer not applied. No time limit is active."
      : "Changes not applied.")
    : "";
  pendingNotice.hidden = !pending;
  errorText.textContent = draftTouched ? draft.error || "" : "";
  errorNotice.hidden = !errorText.textContent;

  const zeroDuration = !draft.error ? false :
    hoursInput.validity.valid && minutesInput.validity.valid &&
    Number(hoursInput.value) + Number(minutesInput.value) === 0;
  hoursInput.setAttribute("aria-invalid",
    String(draftTouched && (!hoursInput.validity.valid || zeroDuration)));
  minutesInput.setAttribute("aria-invalid",
    String(draftTouched && (!minutesInput.validity.valid || zeroDuration)));
}

function updateScheduleSummary() {
  cancelControl.hidden = scheduledEndTime === null;
  scheduleInfo.textContent = scheduledEndTime === null
    ? "No time limit"
    : isScheduleExpired()
      ? "Timer ended"
      : "Ends at " + formatLocalTime(scheduledEndTime);
}

function clearRetryTimer() {
  window.clearTimeout(retryTimer);
  retryTimer = null;
}

function clearScheduleTimer() {
  window.clearTimeout(scheduleTimer);
  scheduleTimer = null;
}

function scheduleRetry(reason, keepError = false) {
  if (retryTimer !== null || document.visibilityState !== "visible" ||
      !shouldMaintainWakeLock()) return;
  if (!keepError) setStatus("waiting");
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    requestWakeLock(reason, true);
  }, 1000);
}

async function releaseWakeLock(reason) {
  const sentinel = wakeLock;
  // Detach before awaiting so old release events cannot overwrite a new lock.
  wakeLock = null;
  if (!sentinel || sentinel.released) return;
  try {
    await sentinel.release();
    log("Wake lock released: " + reason);
  } catch (error) {
    log("Wake lock release failed: " + reason, error);
  }
}

function finishScheduledLock() {
  if (!isScheduleExpired()) return;
  clearScheduleTimer();
  clearRetryTimer();
  setStatus("ended");
  updateScheduleSummary();
  updateDraft();
  releaseWakeLock("timer ended");
}

function startScheduleTimer() {
  clearScheduleTimer();
  if (scheduledEndTime === null) return;
  if (isScheduleExpired()) {
    finishScheduledLock();
    return;
  }
  scheduleTimer = window.setTimeout(() => {
    scheduleTimer = null;
    startScheduleTimer();
  }, Math.min(scheduledEndTime - Date.now(), 24 * 60 * 60 * 1000));
}

function syncInactiveStatus() {
  if (isScheduleExpired()) finishScheduledLock();
  else if (document.visibilityState !== "visible") setStatus("hidden");
  else if (!("wakeLock" in navigator)) setStatus("unsupported");
}

async function requestWakeLock(reason, retry = false) {
  if (!shouldMaintainWakeLock() || document.visibilityState !== "visible") {
    syncInactiveStatus();
    return;
  }
  if (!("wakeLock" in navigator)) {
    setStatus("unsupported");
    log("Screen Wake Lock API is not supported.");
    return;
  }
  if (wakeLock && !wakeLock.released) {
    setStatus("active");
    return;
  }
  if (requestPromise) return requestPromise;

  clearRetryTimer();
  setStatus(retry ? "waiting" : "requesting");
  const requestVersion = visibilityVersion;
  // Defer acquisition so requestPromise is assigned even if the API throws.
  requestPromise = Promise.resolve().then(async () => {
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      if (requestVersion !== visibilityVersion ||
          document.visibilityState !== "visible" ||
          !shouldMaintainWakeLock() || sentinel.released) {
        await sentinel.release();
        syncInactiveStatus();
        if (document.visibilityState === "visible" && shouldMaintainWakeLock()) {
          scheduleRetry("discarded stale wake lock");
        }
        return;
      }

      wakeLock = sentinel;
      sentinel.addEventListener("release", () => {
        if (wakeLock !== sentinel) return;
        wakeLock = null;
        log("Wake lock released by the browser.");
        if (shouldMaintainWakeLock() && document.visibilityState === "visible") {
          scheduleRetry("browser release");
        } else {
          syncInactiveStatus();
        }
      }, { once: true });
      setStatus("active");
      log("Wake lock acquired: " + reason);
    } catch (error) {
      log("Wake lock request failed: " + reason, error);
      if (!shouldMaintainWakeLock() || document.visibilityState !== "visible") {
        syncInactiveStatus();
      } else {
        setStatus("error");
        scheduleRetry("request failure", true);
      }
    } finally {
      requestPromise = null;
    }
  });
  return requestPromise;
}

timerSettings.addEventListener("toggle", () => {
  if (timerSettings.open) {
    draftTouched = true;
    updateDraft();
  }
});

for (const input of [hoursInput, minutesInput]) {
  input.addEventListener("input", () => {
    draftTouched = true;
    updateDraft();
  });
}

scheduleForm.addEventListener("submit", event => {
  event.preventDefault();
  draftTouched = true;
  const draft = readDuration();
  updateDraft();
  if (draft.error || applyButton.disabled) return;

  appliedDuration = { hours: draft.hours, minutes: draft.minutes };
  scheduledEndTime = Date.now() + (draft.hours * 60 + draft.minutes) * 60 * 1000;
  updateScheduleSummary();
  updateDraft();
  startScheduleTimer();
  requestWakeLock("timer applied");
});

cancelButton.addEventListener("click", () => {
  clearScheduleTimer();
  scheduledEndTime = null;
  appliedDuration = null;
  // Reset the editor so cancelling does not immediately create a new reminder.
  hoursInput.value = "1";
  minutesInput.value = "0";
  draftTouched = false;
  timerSettings.open = false;
  updateScheduleSummary();
  updateDraft();
  timerSettings.querySelector("summary").focus();
  requestWakeLock("timer cancelled");
});

document.addEventListener("visibilitychange", () => {
  visibilityVersion += 1;
  updateTitle();
  if (document.visibilityState === "visible") {
    requestWakeLock("page visible");
  } else {
    clearRetryTimer();
    syncInactiveStatus();
    releaseWakeLock("page hidden");
  }
});

window.addEventListener("pageshow", () => {
  updateTitle();
  requestWakeLock("pageshow");
});

updateTitle();
updateScheduleSummary();
updateDraft();
requestWakeLock("initial request");
