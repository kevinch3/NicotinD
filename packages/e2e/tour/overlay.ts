/**
 * Injected into every tour page (`addInitScript`): a visible cursor and a
 * caption pill. Playwright records no pointer, and a tour without one is hard
 * to follow — so a drawn arrow follows the real `mousemove` events the tour
 * dispatches, with a ripple on each click. Captions live in the page rather
 * than in ffmpeg so they share the app's type and render crisply at any scale.
 *
 * Both are `pointer-events: none` and sit above everything: they can never
 * intercept a click the tour makes.
 */
export const OVERLAY_SCRIPT = `(() => {
  if (window.__tour) return;
  const ready = (fn) =>
    document.body ? fn() : document.addEventListener('DOMContentLoaded', fn, { once: true });
  ready(() => {
    const style = document.createElement('style');
    style.textContent = \`
      #tour-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
        width: 26px; height: 26px; transform: translate(-3px, -2px); transition: opacity .2s; }
      .tour-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 44px; height: 44px;
        margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid rgba(129,140,248,.95);
        animation: tour-ripple .5s ease-out forwards; }
      @keyframes tour-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.3); opacity: 0 } }
      #tour-caption { position: fixed; left: 50%; bottom: 112px; z-index: 2147483645; pointer-events: none;
        transform: translate(-50%, 12px); opacity: 0; transition: opacity .35s, transform .35s;
        width: max-content; max-width: 82vw; padding: 14px 28px; border-radius: 18px; text-align: center;
        font: 600 30px/1.25 Inter, 'Helvetica Neue', Arial, sans-serif; letter-spacing: -.01em; color: #fff;
        background: rgba(9, 9, 11, .82); border: 1px solid rgba(255,255,255,.14);
        box-shadow: 0 12px 40px rgba(0,0,0,.45); backdrop-filter: blur(8px); }
      #tour-caption.on { opacity: 1; transform: translate(-50%, 0); }
      #tour-caption.top { bottom: auto; top: 76px; }
      #tour-caption.header { bottom: auto; top: 8px; }
    \`;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = 'tour-cursor';
    cursor.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M3 2l7.5 19 2.6-7.6L21 10.8z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const caption = document.createElement('div');
    caption.id = 'tour-caption';
    document.body.append(cursor, caption);
    const place = (x, y) => (cursor.style.left = x + 'px', cursor.style.top = y + 'px');
    const start = window.__tourCursor || { x: innerWidth / 2, y: innerHeight / 2 };
    place(start.x, start.y);
    addEventListener('mousemove', (e) => place(e.clientX, e.clientY), true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = 'tour-ripple';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }, true);
    window.__tour = {
      caption(text, position) {
        caption.classList.remove('on');
        if (!text) return;
        setTimeout(() => {
          caption.textContent = text;
          caption.classList.toggle('top', position === 'top');
          caption.classList.toggle('header', position === 'header');
          caption.classList.add('on');
        }, caption.textContent ? 180 : 0);
      },
      cursor(visible) { cursor.style.opacity = visible ? '1' : '0'; },
    };
  });
})();`;
