"""Palette proposal generator for #1683. Reads the presets from styles.css, derives the
proposed ramp, and prints the mapping and contrast tables as Markdown."""
import re, sys

css = open(sys.argv[1]).read()
KEYS = ['bg', 'surface', 'surface-2', 'border', 'text-primary', 'text-secondary', 'text-muted',
        'accent', 'accent-text', 'on-accent', 'accent-2', 'accent-2-text', 'on-accent-2']
ORDER = ['midnight', 'daylight', 'warm-paper', 'oled', 'twilight', 'forest', 'eink']
NAMES = {'midnight': 'Midnight', 'daylight': 'Daylight', 'warm-paper': 'Warm Paper', 'oled': 'OLED Black',
         'twilight': 'Twilight', 'forest': 'Forest', 'eink': 'E-Ink'}
LIGHT = {'daylight', 'warm-paper', 'eink'}

presets = {}
for name in ORDER:
    block = re.search(r'\[data-theme="%s"\]\s*\{([^}]*)\}' % name, css).group(1)
    presets[name] = {k: re.search(r'--theme-%s:\s*(#[0-9a-fA-F]{6})' % re.escape(k), block).group(1).lower()
                     for k in KEYS}

def rgb(h): return [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
def hexs(c): return '#' + ''.join('%02x' % round(max(0, min(1, v)) * 255) for v in c)
def lin(v): return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
def lum(h): r, g, b = map(lin, rgb(h)); return 0.2126 * r + 0.7152 * g + 0.0722 * b
def cr(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)
def mix(a, b, t): return hexs([x + (y - x) * t for x, y in zip(rgb(a), rgb(b))])

# The audit's Q5-tinted draft (docs/theme-audit.md), kept verbatim.
DRAFT = {
    'midnight': {'bg': '#0a0a0f', 'surface': '#18181f', 'surface-2': '#25252f', 'surface-3': '#31313d',
                 'border': '#3a3a46', 'text-secondary': '#a8a8b4', 'text-muted': '#9a9aa6',
                 'accent-text': '#8a8cf7'},
    'daylight': {'bg': '#ececf1', 'surface': '#ffffff', 'surface-2': '#e0e0e8', 'surface-3': '#d3d3dd',
                 'border': '#c0c0cc', 'text-secondary': '#4b4b56', 'text-muted': '#585863',
                 'accent': '#5457e8', 'accent-text': '#4245dc'},
}

def lift_text(color, toward, onto, target=4.6):
    """Smallest mix of `color` toward `toward` that reads >= target on every surface in `onto`."""
    t = 0.0
    while min(cr(mix(color, toward, t), s) for s in onto) < target and t < 1:
        t += 0.01
    return mix(color, toward, t)

proposal = {}
for name in ORDER:
    old = presets[name]
    new = dict(old)
    if name in DRAFT:
        new.update(DRAFT[name])
    elif name == 'eink':
        new['surface-3'] = old['surface-2']  # E-Ink rules kept: no new step, no tint
    else:
        fg = old['text-primary']
        if name == 'warm-paper':
            # The audit's measured failure: bg -> surface was 1.03. Raise the card to white rather
            # than darken the page: a darker page drops the amber fill under 3:1 (#1818 lifted it to 3.15).
            new['surface'] = '#ffffff'
        new['surface-3'] = mix(old['surface-2'], fg, 0.08 if name in LIGHT else 0.07)
        new['border'] = mix(old['surface-2'], fg, 0.16 if name in LIGHT else 0.14)
        levels = [new['bg'], new['surface'], new['surface-2'], new['surface-3']]
        new['text-secondary'] = lift_text(old['text-secondary'], fg, levels)
        new['text-muted'] = lift_text(old['text-muted'], fg, levels)
        new['accent-text'] = lift_text(old['accent-text'], fg, [new['surface-2']])
    proposal[name] = new

def fmt(v, target):
    s = '%.2f' % v
    return s if v >= target else '**%s ✗**' % s

out = []
out.append('### Old → new tokens\n')
out.append('| Preset | `bg` | `surface-1` | `surface-2` | `surface-3` (new) | `border` | `text-secondary` | `text-muted` | `accent-text` |')
out.append('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for name in ORDER:
    o, n = presets[name], proposal[name]
    def cell(k):
        if k == 'surface-3': return '`%s`' % n[k]
        ok = 'surface' if k == 'surface-1' else k
        return '`%s`' % o[ok] if o[ok] == n[ok] else '`%s` → `%s`' % (o[ok], n[ok])
    out.append('| %s | %s |' % (NAMES[name], ' | '.join(cell(k) for k in
               ['bg', 'surface-1', 'surface-2', 'surface-3', 'border', 'text-secondary', 'text-muted', 'accent-text'])))
if any(presets['daylight'][k] != proposal['daylight'][k] for k in ['accent']):
    out.append('\nDaylight\'s accent also moves `%s` → `%s` (the draft separates it from Midnight\'s).'
               % (presets['daylight']['accent'], proposal['daylight']['accent']))

out.append('\n### Contrast of the proposal (WCAG 2.x ratio; **✗** marks a miss)\n')
out.append('Targets: 4.5 for text, 3.0 for a fill against the page. A step is a surface level against the one below it; no target, but it must rise.\n')
out.append('| Preset | steps bg→s1 / s1→s2 / s2→s3 | border on s2 | primary on s3 | secondary on bg / s1 / s2 / s3 | muted on bg / s1 / s2 / s3 | accent-text on s2 | accent fill on bg | on-accent on accent | accent-2-text on s2 | on-accent-2 on accent-2 |')
out.append('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
misses = []
for name in ORDER:
    n = proposal[name]
    lv = [n['bg'], n['surface'], n['surface-2'], n['surface-3']]
    steps = ' / '.join('%.2f' % cr(a, b) for a, b in zip(lv, lv[1:]))
    def row(color, target=4.5):
        return ' / '.join(fmt(cr(n[color], s), target) for s in lv)
    cells = [steps, '%.2f' % cr(n['border'], n['surface-2']), fmt(cr(n['text-primary'], n['surface-3']), 4.5),
             row('text-secondary'), row('text-muted'), fmt(cr(n['accent-text'], n['surface-2']), 4.5),
             fmt(cr(n['accent'], n['bg']), 3.0), fmt(cr(n['on-accent'], n['accent']), 4.5),
             fmt(cr(n['accent-2-text'], n['surface-2']), 4.5), fmt(cr(n['on-accent-2'], n['accent-2']), 4.5)]
    line = '| %s | %s |' % (NAMES[name], ' | '.join(cells))
    out.append(line)
    if '✗' in line: misses.append(NAMES[name])
out.append('\nMisses: %s.' % (', '.join(misses) if misses else 'none'))
print('\n'.join(out))
