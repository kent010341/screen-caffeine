const logElement = document.getElementById("log");
const logContainer = document.getElementById("log-container");
const statusElement = document.getElementById("status");

const permanentModeInput = document.getElementById("permanent-mode");
const scheduledModeInput = document.getElementById("scheduled-mode");
const scheduleForm = document.getElementById("schedule-form");
const hoursInput = document.getElementById("duration-hours");
const minutesInput = document.getElementById("duration-minutes");
const applyScheduleButton = document.getElementById("apply-schedule");
const scheduleInfoElement = document.getElementById("schedule-info");
const scheduleErrorElement = document.getElementById("schedule-error");

let wakeLock = null;
let requestPromise = null;
let retryTimer = null;
let scheduleTimer = null;

let activeMode = "permanent";
let scheduledEndTime = null;

function setStatus(state, text) {
  statusElement.dataset.state = state;
  statusElement.textContent = text;
}

function log(message) {
  const timestamp = new Date().toISOString();

  logElement.textContent += `[${timestamp}] ${message}\n`;
  logContainer.scrollTop = logContainer.scrollHeight;
}

function formatLocalTime(date) {
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  });
}

function clearRetryTimer() {
  if (retryTimer === null) {
    return;
  }

  window.clearTimeout(retryTimer);
  retryTimer = null;
}

function clearScheduleTimer() {
  if (scheduleTimer === null) {
    return;
  }

  window.clearTimeout(scheduleTimer);
  scheduleTimer = null;
}

function isScheduleExpired() {
  return (
    activeMode === "scheduled" &&
    scheduledEndTime !== null &&
    Date.now() >= scheduledEndTime.getTime()
  );
}

function shouldMaintainWakeLock() {
  if (activeMode === "permanent") {
    return true;
  }

  return (
    activeMode === "scheduled" &&
    scheduledEndTime !== null &&
    Date.now() < scheduledEndTime.getTime()
  );
}

function updateScheduleControls() {
  const scheduledModeSelected = scheduledModeInput.checked;

  hoursInput.disabled = !scheduledModeSelected;
  minutesInput.disabled = !scheduledModeSelected;
  applyScheduleButton.disabled = !scheduledModeSelected;
}

function showPermanentMode() {
  scheduleInfoElement.innerHTML =
    "Current mode: <strong>Permanent</strong>";
}

function showScheduledMode(endTime) {
  scheduleInfoElement.innerHTML =
    "Current mode: <strong>Scheduled</strong><br>" +
    `Lock ends at: <strong>${formatLocalTime(endTime)}</strong>`;
}

function showExpiredSchedule(endTime) {
  scheduleInfoElement.innerHTML =
    "Current mode: <strong>Scheduled — ended</strong><br>" +
    `Lock ended at: <strong>${formatLocalTime(endTime)}</strong>`;
}

function scheduleRetry(reason) {
  if (
    retryTimer !== null ||
    document.visibilityState !== "visible" ||
    !shouldMaintainWakeLock()
  ) {
    return;
  }

  setStatus("waiting", "Waiting to retry");
  log(`Scheduling retry in 1000 ms: ${reason}`);

  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    requestWakeLock("scheduled retry");
  }, 1000);
}

async function releaseWakeLock(reason) {
  clearRetryTimer();

  const currentWakeLock = wakeLock;

  if (currentWakeLock === null || currentWakeLock.released) {
    wakeLock = null;
    log(`No active wake lock to release: ${reason}`);
    return;
  }

  log(`Releasing screen wake lock: ${reason}`);

  try {
    await currentWakeLock.release();
  } catch (error) {
    const name = error?.name ?? "Error";
    const message = error?.message ?? String(error);

    log(`Wake lock release failed: ${name}: ${message}`);
  } finally {
    if (wakeLock === currentWakeLock) {
      wakeLock = null;
    }
  }
}

async function finishScheduledLock() {
  if (
    activeMode !== "scheduled" ||
    scheduledEndTime === null
  ) {
    return;
  }

  const endedAt = scheduledEndTime;

  clearScheduleTimer();
  clearRetryTimer();

  setStatus("ended", "Schedule ended");
  showExpiredSchedule(endedAt);

  log(
    `Scheduled wake lock period ended at ${formatLocalTime(endedAt)}.`
  );

  await releaseWakeLock("scheduled end time reached");
}

function startScheduleTimer() {
  clearScheduleTimer();

  if (
    activeMode !== "scheduled" ||
    scheduledEndTime === null
  ) {
    return;
  }

  const remainingMilliseconds =
    scheduledEndTime.getTime() - Date.now();

  if (remainingMilliseconds <= 0) {
    finishScheduledLock();
    return;
  }

  const maximumTimerDelay = 24 * 60 * 60 * 1000;
  const timerDelay = Math.min(
    remainingMilliseconds,
    maximumTimerDelay
  );

  scheduleTimer = window.setTimeout(() => {
    scheduleTimer = null;

    if (isScheduleExpired()) {
      finishScheduledLock();
      return;
    }

    startScheduleTimer();
  }, timerDelay);
}

async function requestWakeLock(reason) {
  if (!("wakeLock" in navigator)) {
    setStatus("unsupported", "Unsupported");
    log("Screen Wake Lock API is not supported.");
    return;
  }

  if (!shouldMaintainWakeLock()) {
    if (isScheduleExpired()) {
      setStatus("ended", "Schedule ended");
    }

    log(
      "Request skipped because the current policy does not " +
      `require a wake lock: ${reason}`
    );

    return;
  }

  if (document.visibilityState !== "visible") {
    setStatus("hidden", "Paused while hidden");
    log(`Request skipped because document is hidden: ${reason}`);
    return;
  }

  if (wakeLock !== null && !wakeLock.released) {
    setStatus("active", "Active");

    log(
      "Request skipped because wake lock is already active: " +
      reason
    );

    return;
  }

  if (requestPromise !== null) {
    log(
      "Request skipped because another request is pending: " +
      reason
    );

    return requestPromise;
  }

  setStatus("requesting", "Requesting");
  log(`Requesting screen wake lock: ${reason}`);

  requestPromise = (async () => {
    try {
      const sentinel = await navigator.wakeLock.request("screen");

      if (!shouldMaintainWakeLock()) {
        log(
          "Wake lock was acquired after the policy had ended; " +
          "releasing it immediately."
        );

        await sentinel.release();
        setStatus("ended", "Schedule ended");
        return;
      }

      wakeLock = sentinel;

      setStatus("active", "Active");
      log("Screen wake lock acquired.");

      sentinel.addEventListener(
        "release",
        () => {
          log("Screen wake lock released.");

          if (wakeLock === sentinel) {
            wakeLock = null;
          }

          if (!shouldMaintainWakeLock()) {
            if (isScheduleExpired()) {
              setStatus("ended", "Schedule ended");
            }

            return;
          }

          if (document.visibilityState === "visible") {
            setStatus("waiting", "Released; retrying");
            scheduleRetry("wake lock release event");
          } else {
            setStatus("hidden", "Paused while hidden");
          }
        },
        { once: true }
      );
    } catch (error) {
      const name = error?.name ?? "Error";
      const message = error?.message ?? String(error);

      setStatus("error", `${name}: ${message}`);
      log(`Wake lock request failed: ${name}: ${message}`);

      scheduleRetry("request failure");
    } finally {
      requestPromise = null;
    }
  })();

  return requestPromise;
}

permanentModeInput.addEventListener("change", () => {
  if (!permanentModeInput.checked) {
    return;
  }

  updateScheduleControls();
  scheduleErrorElement.textContent = "";

  activeMode = "permanent";
  scheduledEndTime = null;

  clearScheduleTimer();
  showPermanentMode();

  log("Wake lock mode changed to permanent.");
  requestWakeLock("permanent mode selected");
});

scheduledModeInput.addEventListener("change", () => {
  if (!scheduledModeInput.checked) {
    return;
  }

  updateScheduleControls();
  scheduleErrorElement.textContent = "";
  hoursInput.focus();
});

scheduleForm.addEventListener("submit", async event => {
  event.preventDefault();

  scheduleErrorElement.textContent = "";

  if (
    !hoursInput.reportValidity() ||
    !minutesInput.reportValidity()
  ) {
    return;
  }

  const hours = Number(hoursInput.value);
  const minutes = Number(minutesInput.value);

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes)
  ) {
    scheduleErrorElement.textContent =
      "Hours and minutes must be whole numbers.";

    return;
  }

  const totalMinutes = hours * 60 + minutes;

  if (totalMinutes <= 0) {
    scheduleErrorElement.textContent =
      "The scheduled duration must be at least one minute.";

    return;
  }

  const durationMilliseconds = totalMinutes * 60 * 1000;

  scheduledEndTime = new Date(
    Date.now() + durationMilliseconds
  );

  activeMode = "scheduled";

  showScheduledMode(scheduledEndTime);
  startScheduleTimer();

  log(
    `Scheduled mode applied for ${hours} hour(s) and ` +
    `${minutes} minute(s).`
  );

  log(
    `Scheduled local end time: ${formatLocalTime(scheduledEndTime)}.`
  );

  if (document.visibilityState === "visible") {
    await requestWakeLock("scheduled mode applied");
  } else {
    setStatus("hidden", "Paused while hidden");
  }
});

document.addEventListener("visibilitychange", () => {
  log(`Visibility changed: ${document.visibilityState}`);

  if (document.visibilityState === "visible") {
    if (isScheduleExpired()) {
      finishScheduledLock();
      return;
    }

    requestWakeLock("document became visible");
    return;
  }

  if (shouldMaintainWakeLock()) {
    setStatus("hidden", "Paused while hidden");
  }

  if (retryTimer !== null) {
    clearRetryTimer();

    log(
      "Pending retry cancelled because document is hidden."
    );
  }
});

window.addEventListener("pageshow", () => {
  if (isScheduleExpired()) {
    finishScheduledLock();
    return;
  }

  requestWakeLock("pageshow");
});

updateScheduleControls();
showPermanentMode();

log("Page initialized.");
log("Wake lock mode initialized as permanent.");

requestWakeLock("initial request");
