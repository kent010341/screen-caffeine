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
 * Mini window features. A huge `top` makes the browser clamp the window to the bottom of the
 * screen it chooses (Firefox: primary screen; Chrome/Edge: the opener's screen), so the window
 * lands bottom-left without knowing any screen size.
 */
const MINI_FEATURES = 'popup,width=280,height=240,left=0,top=99999';

/**
 * Whether the URL asks to open the mini window on load (`?popup`, any value).
 * @param {string} href Current page URL.
 * @returns {boolean} Auto-open requested.
 */
export function isPopupRequested(href) {
    return new URL(href).searchParams.has('popup');
}

/**
 * Connect the full-page button (and optional ?popup auto-open) to one reusable mini window per session.
 * @param {{id: string}} session Shared session identity.
 */
export function setupMiniButton(session) {
    /** Mini window opened from this full page. */
    let miniWindow = null;
    /** Popup failure feedback separate from wake lock and timer feedback. */
    const notice = document.getElementById('popup-notice');
    /** Tells the user this page can be closed while the mini window runs. */
    const hint = document.getElementById('close-hint');

    /** Hide the close hint once the mini window is gone. */
    function watchMini() {
        if (miniWindow && !miniWindow.closed) {
            window.setTimeout(watchMini, 1000);
        } else {
            hint.hidden = true;
        }
    }

    /** Open or focus the mini window. */
    function openMini() {
        notice.hidden = true;
        try {
            if (!miniWindow || miniWindow.closed) {
                miniWindow = window.open(pageUrl('mini.html', session.id),
                    'screen-caffeine-mini-' + session.id, MINI_FEATURES);
                if (miniWindow) {
                    window.setTimeout(watchMini, 1000);
                }
            }
            if (miniWindow) {
                miniWindow.focus();
                hint.hidden = false;
            } else {
                notice.hidden = false;
            }
        } catch (error) {
            notice.hidden = false;
            console.debug('[Screen Caffeine] Cannot open mini window.', error);
        }
    }

    document.getElementById('open-mini').addEventListener('click', openMini);
    if (isPopupRequested(window.location.href)) {
        openMini();
    }
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
