import { createWakeController } from '@screen-caffeine/wake-controller.js';
import { createSession } from '@screen-caffeine/session.js';
import { renderStatus } from '@screen-caffeine/status-view.js';
import { setupFullPageLink } from '@screen-caffeine/window-navigation.js';

/** Shared applied settings retained independently of the opener. */
const session = createSession();
/** Latest applied absolute deadline. */
let deadline = null;
/** Read-only remaining-time summary. */
const summary = document.getElementById('schedule-info');
/** Document-local acquisition controller. */
const controller = createWakeController(renderStatus, updateSummary);

/** Show remaining time without extending the shared deadline. */
function updateSummary() {
    if (deadline === null) {
        summary.textContent = 'No time limit';
    } else if (Date.now() >= deadline) {
        summary.textContent = 'Timer ended';
    } else {
        /** Rounded-up seconds avoid displaying zero before expiry. */
        const seconds = Math.ceil((deadline - Date.now()) / 1000);
        /** Remaining hours, including multi-day schedules. */
        const hours = Math.floor(seconds / 3600);
        /** Remaining minute component. */
        const minutes = Math.floor(seconds % 3600 / 60);
        /** Remaining second component. */
        const remainder = seconds % 60;
        summary.textContent = hours > 0
            ? `${hours}h ${minutes}m remaining`
            : `${minutes}m ${remainder}s remaining`;
    }
}

session.subscribe(settings => {
    deadline = settings.deadline;
    updateSummary();
    controller.setDeadline(deadline);
});
window.setInterval(updateSummary, 1000);
setupFullPageLink(session);
controller.start();
