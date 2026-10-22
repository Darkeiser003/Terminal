// Se ejecuta tanto en WebView2 como en WebKit: no usa referencias WebDriver
// ni el ancho del contenedor como sustituto del ancho de sus botones.
export function measureToolbarLayout() {
    const toolbar = document.querySelector('.toolbar');
    if (!toolbar) return { present: false, controls: [], overlaps: [], clipped: [] };
    const bounds = toolbar.getBoundingClientRect();
    const selectors = [
        '.env-select',
        '[data-testid="refresh-environments"]',
        '.repl-favorites',
        '.toolbar-group:not(.grow) > button',
        '.lang-btn',
    ];
    const controls = [...toolbar.querySelectorAll(selectors.join(','))]
        .filter(node => node.getClientRects().length > 0)
        .map(node => {
            const rect = node.getBoundingClientRect();
            return {
                id: node.dataset.testid ?? node.className,
                left: rect.left, right: rect.right,
                top: rect.top, bottom: rect.bottom,
                width: rect.width, height: rect.height,
            };
        });
    const overlaps = [];
    for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
            const a = controls[i], b = controls[j];
            if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
                && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) {
                overlaps.push([a.id, b.id]);
            }
        }
    }
    const clipped = controls.filter(control => control.width <= 0 || control.height <= 0
        || control.left < Math.max(0, bounds.left) - 0.5
        || control.right > Math.min(innerWidth, bounds.right) + 0.5
        || control.top < bounds.top - 0.5 || control.bottom > bounds.bottom + 0.5);
    return { present: true, viewportWidth: innerWidth, controls, overlaps, clipped };
}

export function toolbarLayoutIsValid(snapshot) {
    return snapshot?.present === true && Number.isFinite(snapshot.viewportWidth)
        && snapshot.viewportWidth > 0
        && Array.isArray(snapshot.controls) && snapshot.controls.length > 0
        && Array.isArray(snapshot.overlaps) && snapshot.overlaps.length === 0
        && Array.isArray(snapshot.clipped) && snapshot.clipped.length === 0;
}
