#!/usr/bin/env python3
"""Generate nolock's font-independent monochrome SVG masters.

Run from any directory: python3 scripts/generate-brand.py
Desktop raster packages: npx tauri icon src/assets/nolock-icon.svg -o /tmp/nolock-icons
"""
from pathlib import Path

ASSETS = Path(__file__).resolve().parents[1] / 'src' / 'assets'

# Shared geometry: 16-unit stems, circular bowls, 45-degree slash.
N = '<path d="M24 168V90H40V101C47 92 57 88 69 88C91 88 104 103 104 128V168H88V129C88 112 81 104 68 104C52 104 40 115 40 132V168Z"/>'
O = '<circle cx="160" cy="128" r="32" fill="none" stroke-width="16"/>'
SLASH = '<path d="M137 151L183 105" fill="none" stroke-width="14"/>'
# A filled outline preserves the original curved latch notch at the free tip.
# The cutout is transparent, so it works on both light and dark backgrounds.
SHACKLE = ('<path transform="translate(314 50) rotate(20)" '
           'd="M-36 26V0A36 36 0 0 1 36 0V46H22V0A22 22 0 0 0 -22 0'
           'V10C-27 10 -30 14 -30 18H-22V26Q-22 28 -24 28H-34Q-36 28 -36 26Z"/>')
WORD = (N + O + SLASH
        + '<rect x="218" y="44" width="16" height="124" rx="2"/>'
        + '<g transform="translate(-14 0)">' + SHACKLE
        + '<circle cx="308" cy="128" r="32" fill="none" stroke-width="16"/>'
        + '<path d="M425 105A32 32 0 1 0 425 151" fill="none" stroke-width="16"/>'
        + '<path d="M450 44H466V120L491 90H511L479 128L515 168H495L466 134V168H450Z"/></g>')
# The compact mark combines the two signatures in one o for small surfaces.
MARK = N + O + SLASH + '<g transform="translate(-148 0)">' + SHACKLE + '</g>'


def svg(viewbox, width, height, color, geometry, title='nolock'):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" width="{width}" height="{height}" fill="none">
  <title>{title}</title>
  <g fill="{color}" stroke="{color}" stroke-width="0">{geometry}</g>
</svg>
'''


for suffix, color in [('', '#000000'), ('-white', '#FFFFFF')]:
    (ASSETS / f'nolocklogo{suffix}.svg').write_text(svg('8 8 498 176', 498, 176, color, WORD))
    (ASSETS / f'nolock-mark{suffix}.svg').write_text(svg('8 8 208 176', 208, 176, color, MARK))
# Retain the existing compact asset name for consumers outside this repository.
(ASSETS / 'nolocklogo-white-no.svg').write_text(svg('8 8 208 176', 208, 176, '#FFFFFF', MARK))
icon = '<rect x="16" y="16" width="480" height="480" rx="108" fill="#000000"/><g transform="translate(42 56) scale(1.9)" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="0">' + MARK + '</g>'
(ASSETS / 'nolock-icon.svg').write_text(svg('0 0 512 512', 512, 512, '#000000', icon, 'nolock app icon'))

# Optional desktop exports use Tauri's own SVG renderer and packager.
if __name__ == '__main__':
    import argparse
    import shutil
    import subprocess
    import tempfile

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--icons', action='store_true', help='also regenerate desktop PNG, ICO and ICNS assets with the installed Tauri CLI')
    args = parser.parse_args()
    if args.icons:
        root = ASSETS.parents[1]
        with tempfile.TemporaryDirectory(prefix='nolock-brand-') as temp:
            subprocess.run(['npx', '--no-install', 'tauri', 'icon', str(ASSETS / 'nolock-icon.svg'), '-o', temp], cwd=root, check=True)
            for name in ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.ico', 'icon.icns']:
                shutil.copyfile(Path(temp) / name, root / 'src-tauri' / 'icons' / name)
