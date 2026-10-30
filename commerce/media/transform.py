"""Untrusted decoder. No network, credentials, paths or options supplied by the client."""
import json
import os
import resource
import sys
import warnings
from pathlib import Path

# Set before importing the decoder. Production runs on Linux in a separate bounded container.
resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024,) * 2)
resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024,) * 2)
resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 16_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

def run():
    root = Path(sys.argv[1])
    source = root / 'source'
    if not 0 < source.stat().st_size <= 8 * 1024 * 1024:
        raise ValueError('size')
    with Image.open(source, formats=['JPEG', 'PNG', 'WEBP']) as probe:
        if probe.format not in ('JPEG', 'PNG', 'WEBP') or getattr(probe, 'n_frames', 1) != 1:
            raise ValueError('format')
        if max(probe.size) > 8192 or probe.width * probe.height > 16_000_000:
            raise ValueError('pixels')
        probe.verify()
    with Image.open(source, formats=['JPEG', 'PNG', 'WEBP']) as decoded:
        decoded.load()
        oriented = ImageOps.exif_transpose(decoded)
        # Do not copy info/EXIF/ICC/XMP from the input object.
        pixels = Image.new('RGBA' if 'A' in oriented.getbands() else 'RGB', oriented.size)
        pixels.paste(oriented)
        results = []
        for width in (480, 960, 1600):
            image = pixels.copy()
            image.thumbnail((width, width * 8192), Image.Resampling.LANCZOS)
            name = str(width) + '.webp'
            image.save(root / name, 'WEBP', quality=82, method=4, exact=True)
            results.append({'profile': width, 'width': image.width, 'height': image.height})
            image.close()
        pixels.close()
    print(json.dumps(results))

try:
    run()
except Exception:
    # Never echo image metadata, local paths or decoder exception details.
    print('IMAGE_REJECTED', file=sys.stderr)
    sys.exit(1)
