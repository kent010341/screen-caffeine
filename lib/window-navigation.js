/**
 * Create a same-origin page URL preserving the session identity.
 * @param {string} page Sibling HTML resource.
 * @param {string} id Shared session identity.
 * @returns {URL} Navigation destination.
 */
function pageUrl(page, id) {
    /** Destination resolved relative to the current deployment directory. */
    const url = new URL(page, window.location.href);
    url.searchParams.set('session', id);
    return url;
}

/**
 * Connect the full-page button to one reusable mini window per session.
 * @param {{id: string}} session Shared session identity.
 */
export function setupMiniButton(session) {
    /** Mini window opened from this full page. */
    let miniWindow = null;
    /** Popup failure feedback separate from wake lock and timer feedback. */
    const notice = document.getElementById('popup-notice');
    document.getElementById('open-mini').addEventListener('click', () => {
        notice.hidden = true;
        try {
            if (!miniWindow || miniWindow.closed) {
                miniWindow = window.open(pageUrl('mini.html', session.id),
                    'screen-caffeine-mini-' + session.id, 'popup,width=280,height=240');
            }
            if (miniWindow) {
                miniWindow.focus();
            } else {
                notice.hidden = false;
            }
        } catch (error) {
            notice.hidden = false;
            console.debug('[Screen Caffeine] Cannot open mini window.', error);
        }
    });
}

/**
 * Return to the original full page or open a replacement in the same session.
 * @param {{id: string}} session Shared session identity.
 */
export function setupFullPageLink(session) {
    /** Accessible native link also works if JavaScript navigation is blocked. */
    const link = document.getElementById('open-full');
    link.href = pageUrl('index.html', session.id).href;
    link.addEventListener('click', event => {
        try {
            if (window.opener && !window.opener.closed &&
                window.opener.location.origin === window.location.origin &&
                new URL(window.opener.location.href).searchParams.get('session') === session.id) {
                window.opener.focus();
                event.preventDefault();
            }
        } catch (error) {
            console.debug('[Screen Caffeine] Original page unavailable.', error);
        }
    });
}
