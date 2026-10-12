/** State text and icon mapping shared by both interfaces. */
const statuses = {
    active: ['Screen caffeinated', 'coffee'],
    requesting: ['Starting…', 'clock'],
    waiting: ['Reconnecting…', 'clock'],
    hidden: ['Paused', 'monitor-off'],
    ended: ['Timer ended', 'clock'],
    error: ['Unable to keep screen awake', 'triangle-alert'],
    unsupported: ['Wake lock unavailable', 'triangle-alert']
};

/**
 * Render this document's state, never the other window's acquisition status.
 * @param {string} state Wake controller status.
 */
export function renderStatus(state) {
    /** Human-readable state and corresponding icon. */
    const [text, icon] = statuses[state];
    document.getElementById('wake-status').dataset.state = state;
    document.getElementById('status').textContent = text;
    document.getElementById('status-icon').className = 'icon icon-' + icon;
}
