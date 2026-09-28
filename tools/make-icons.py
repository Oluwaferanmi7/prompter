"""Draw the Sapphire Prompter app icons (placeholder until the final Sapphire logo exists).

The brand kit's logo concept: an aperture iris that doubles as a gemstone facet. Six gold
blades around a sapphire hexagon, on Midnight. Rendered large and scaled down for smooth
edges.

    python tools/make-icons.py      (needs Pillow)
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

MIDNIGHT = (11, 22, 40)
SAPPHIRE = (30, 79, 175)
SKY = (91, 155, 240)
GOLD = (197, 169, 74)
OUT = Path(__file__).resolve().parent.parent / 'app' / 'icons'


def mark(size, bg=None, scale=0.78):
    """Aperture mark centred on a square canvas. scale = mark diameter / canvas."""
    S = size * 4
    im = Image.new('RGBA', (S, S), bg + (255,) if bg else (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = S / 2
    R = S * scale / 2  # outer ring radius
    ring = R * 0.085  # ring thickness
    r = R * 0.42  # inner hexagon (the gem)
    rot = -math.pi / 2  # a vertex at the top

    # Gem: a faceted sapphire hexagon.
    hexa = [(c + r * math.cos(rot + i * math.pi / 3), c + r * math.sin(rot + i * math.pi / 3)) for i in range(6)]
    # six facets from the centre, lit from the top left
    shades = [SKY, (64, 124, 222), SAPPHIRE, (22, 58, 132), (40, 98, 200), (74, 138, 232)]
    for i in range(6):
        d.polygon([(c, c), hexa[i], hexa[(i + 1) % 6]], fill=shades[i])

    # Blades: from each hexagon vertex, a line along the next edge's direction out to the
    # ring. That gives the pinwheel look of a camera aperture.
    w = max(2, int(R * 0.07))
    for i in range(6):
        a = hexa[i]
        b = hexa[(i + 1) % 6]
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy)
        dx, dy = dx / n, dy / n
        # distance t along the ray from a until it meets the inner edge of the ring
        fx, fy = a[0] - c, a[1] - c
        inner = R - ring / 2
        bb = fx * dx + fy * dy
        t = -bb + math.sqrt(bb * bb - (fx * fx + fy * fy - inner * inner))
        d.line([a, (a[0] + dx * t, a[1] + dy * t)], fill=GOLD, width=w)
    d.line(hexa + [hexa[0]], fill=GOLD, width=w, joint='curve')
    d.ellipse([c - R, c - R, c + R, c + R], outline=GOLD, width=int(ring))
    return im.resize((size, size), Image.LANCZOS)


def main():
    mark(512, MIDNIGHT, 0.74).save(OUT / 'icon-512.png')
    mark(192, MIDNIGHT, 0.74).save(OUT / 'icon-192.png')
    mark(180, MIDNIGHT, 0.74).convert('RGB').save(OUT / 'apple-touch-icon.png')
    mark(512, MIDNIGHT, 0.56).save(OUT / 'icon-512-maskable.png')  # Android's safe zone
    mark(256).save(OUT / 'sapphire-mark.png')  # transparent, for the splash and headers
    print('icons written to', OUT)


if __name__ == '__main__':
    main()
