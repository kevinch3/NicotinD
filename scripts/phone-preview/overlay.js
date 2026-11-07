// Preview-only viewport readout. scripts/phone-preview.ts injects this into the STAGED copy of
// index.html — it is never part of the shipped bundle. Tap the readout to collapse it.
(function () {
  var box = document.createElement('div');
  box.style.cssText =
    'position:fixed;top:env(safe-area-inset-top,0);left:0;right:0;z-index:2147483647;' +
    'font:10px/1.3 ui-monospace,Menlo,monospace;color:#0f0;background:rgba(0,0,0,.78);' +
    'padding:2px 6px;white-space:pre;pointer-events:auto;';
  var collapsed = false;
  box.addEventListener('click', function () {
    collapsed = !collapsed;
    render();
  });

  // A hidden element per unit: its laid-out height IS the unit's resolved value.
  var probes = document.createElement('div');
  probes.style.cssText = 'position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;';
  [
    ['dvh', 'height:100dvh'],
    ['svh', 'height:100svh'],
    ['lvh', 'height:100lvh'],
    ['inset-b', 'height:env(safe-area-inset-bottom,0px)'],
    ['inset-t', 'height:env(safe-area-inset-top,0px)'],
    ['fixed-b0', 'position:fixed;bottom:0;height:0'],
  ].forEach(function (p) {
    var el = document.createElement('div');
    el.setAttribute('data-probe', p[0]);
    el.style.cssText = p[1];
    probes.appendChild(el);
  });

  function probe(name) {
    var el = probes.querySelector('[data-probe="' + name + '"]');
    return name === 'fixed-b0' ? el.getBoundingClientRect().bottom : el.getBoundingClientRect().height;
  }
  function r(n) {
    return Math.round(n * 10) / 10;
  }

  function render() {
    var vv = window.visualViewport;
    // The tab bar itself: `[data-bottom-chrome]` also matches the (often hidden) mini player.
    var nav = document.querySelector('app-bottom-nav > *');
    // `md:hidden`: no tab bar (zero-height box) in the desktop layout, e.g. a phone in landscape.
    var navBottom = nav && nav.getBoundingClientRect().height > 0 ? nav.getBoundingClientRect().bottom : null;
    // iOS never swaps screen.width/height on rotation: take the long edge in portrait, the short in landscape.
    var long = Math.max(screen.width, screen.height), short = Math.min(screen.width, screen.height);
    var physicalHeight = innerWidth > innerHeight ? short : long;
    var standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    var lines = [
      'standalone=' + standalone + '  screen=' + screen.width + 'x' + screen.height,
      'inner=' + innerWidth + 'x' + innerHeight + '  clientH=' + document.documentElement.clientHeight,
      'visual=' + (vv ? r(vv.height) + ' top=' + r(vv.offsetTop) : 'n/a'),
      'dvh=' + r(probe('dvh')) + ' svh=' + r(probe('svh')) + ' lvh=' + r(probe('lvh')),
      'inset t=' + r(probe('inset-t')) + ' b=' + r(probe('inset-b')),
      'fixed-bottom-0 @ y=' + r(probe('fixed-b0')) + '  nav bottom=' + (navBottom === null ? 'n/a' : r(navBottom)),
      'GAP below nav = ' + (navBottom === null ? 'n/a' : r(physicalHeight - navBottom)) + 'pt (of ' + physicalHeight + ')',
    ];
    box.textContent = collapsed ? lines[lines.length - 1] : lines.join('\n');
  }

  function mount() {
    document.body.appendChild(probes);
    document.body.appendChild(box);
    render();
    ['resize', 'orientationchange', 'scroll', 'pageshow', 'visibilitychange'].forEach(function (e) {
      window.addEventListener(e, render, { passive: true });
    });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', render);
    setInterval(render, 1000);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
