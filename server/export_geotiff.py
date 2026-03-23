#!/usr/bin/env python3
"""
Generate annual mean GRACE LWE GeoTIFFs from pre-extracted pixel data.
Pure Python — no GDAL/rasterio/scipy dependency.

Reads a JSON payload from stdin (provided by Node which already has the
binary in memory — avoids loading the 251MB binary twice).

Usage:
  echo '<json>' | python3 export_geotiff.py <out_zip>

JSON schema (produced by exportBBoxData in grace.ts):
  {
    lats:      float[]   # subset lat centres, ascending (south→north)
    lons:      float[]   # subset lon centres (-180..180), west→east
    times:     float[]   # days since 2002-01-01
    nT, nR, nC: int      # time steps, rows, cols
    fillValue: float     # sentinel for missing data (-99999)
    values:    float[]   # flat [nT * nR * nC] row-major float array
    minLat, maxLat, minLon, maxLon: float
  }
"""
import sys, json, zipfile, io, struct
import numpy as np
from datetime import datetime, timedelta


# ── Pure-Python GeoTIFF writer ────────────────────────────────────────────────

def write_geotiff(data2d, west, north, cell_deg, nodata=-9999.0):
    """
    data2d   : numpy float32 array, shape (nrows, ncols), row 0 = northernmost
    west     : left edge longitude (degrees)
    north    : top  edge latitude  (degrees)
    cell_deg : pixel size in degrees (square pixels)
    Returns  : bytes of a valid GeoTIFF readable by QGIS / ArcGIS / GDAL
    """
    nrows, ncols = data2d.shape
    d = data2d.copy().astype(np.float32)
    d[np.isnan(d)] = nodata
    image_bytes = d.tobytes()
    image_size  = len(image_bytes)

    # ── Blob offsets (all placed after the 8-byte TIFF header) ───────────────
    image_offset    = 8
    pix_scale       = struct.pack('<3d', cell_deg, cell_deg, 0.0)   # ModelPixelScaleTag
    tiepoint        = struct.pack('<6d', 0.0, 0.0, 0.0,             # ModelTiepointTag
                                        west, north, 0.0)
    # GeoKeyDirectory: 4-short header + 3 keys × 4 shorts each
    geokeys = struct.pack('<16H',
        1, 1, 0, 3,           # KeyDirVersion, Revision, MinorRevision, NumKeys
        1024, 0, 1, 2,        # GTModelTypeGeoKey = ModelTypeGeographic
        1025, 0, 1, 1,        # GTRasterTypeGeoKey = RasterPixelIsArea
        2048, 0, 1, 4326,     # GeographicTypeGeoKey = EPSG:4326 WGS84
    )
    nodata_str = f'{nodata:g}\x00'.encode('ascii')

    pix_scale_offset = image_offset + image_size
    tiepoint_offset  = pix_scale_offset + len(pix_scale)
    geokeys_offset   = tiepoint_offset  + len(tiepoint)
    nodata_offset    = geokeys_offset   + len(geokeys)
    ifd_offset       = nodata_offset    + len(nodata_str)

    # ── IFD entries (tag, type, count, value_or_offset) ──────────────────────
    SHORT=3; LONG=4; DOUBLE=12; ASCII=2
    def entry(tag, typ, count, val):
        return struct.pack('<HHII', tag, typ, count, val)

    entries = sorted([
        entry(256,   SHORT,  1,                  ncols),
        entry(257,   SHORT,  1,                  nrows),
        entry(258,   SHORT,  1,                  32),            # BitsPerSample=32
        entry(259,   SHORT,  1,                  1),             # Compression=none
        entry(262,   SHORT,  1,                  1),             # PhotometricInterp
        entry(273,   LONG,   1,                  image_offset),  # StripOffsets
        entry(278,   LONG,   1,                  nrows),         # RowsPerStrip
        entry(279,   LONG,   1,                  image_size),    # StripByteCounts
        entry(284,   SHORT,  1,                  1),             # PlanarConfig
        entry(339,   SHORT,  1,                  3),             # SampleFormat=float
        entry(33550, DOUBLE, 3,                  pix_scale_offset),
        entry(33922, DOUBLE, 6,                  tiepoint_offset),
        entry(34735, SHORT,  len(geokeys)//2,    geokeys_offset),
        entry(42113, ASCII,  len(nodata_str),    nodata_offset),
    ], key=lambda e: struct.unpack('<H', e[:2])[0])   # must be tag-sorted

    n_entries  = len(entries)
    ifd_bytes  = struct.pack('<H', n_entries) + b''.join(entries) + struct.pack('<I', 0)

    # ── Assemble ──────────────────────────────────────────────────────────────
    buf = io.BytesIO()
    buf.write(b'II')                        # little-endian marker
    buf.write(struct.pack('<H', 42))        # TIFF magic
    buf.write(struct.pack('<I', ifd_offset))
    buf.write(image_bytes)
    buf.write(pix_scale)
    buf.write(tiepoint)
    buf.write(geokeys)
    buf.write(nodata_str)
    buf.write(ifd_bytes)
    return buf.getvalue()


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) != 2:
        print("Usage: echo '<json>' | python3 export_geotiff.py <out_zip>",
              file=sys.stderr)
        sys.exit(1)

    out_zip = sys.argv[1]

    # Read JSON payload from stdin
    payload = json.loads(sys.stdin.read())

    lats      = payload['lats']       # ascending (south→north)
    lons      = payload['lons']       # west→east, -180..180
    times     = payload['times']      # days since 2002-01-01
    nT        = payload['nT']
    nR        = payload['nR']
    nC        = payload['nC']
    fill      = payload['fillValue']
    flat      = payload['values']
    min_lat   = payload['minLat']
    max_lat   = payload['maxLat']
    min_lon   = payload['minLon']
    max_lon   = payload['maxLon']

    # Reconstruct 3-D array [nT, nR, nC]
    data = np.array(flat, dtype=np.float32).reshape(nT, nR, nC)
    data[np.abs(data - fill) < 1.0] = np.nan

    # Parse times → year
    base = datetime(2002, 1, 1)
    def days_to_year(d):
        return (base + timedelta(days=float(d))).year

    years_all    = [days_to_year(t) for t in times]
    unique_years = sorted(set(years_all))

    cell = 0.5  # GRACE pixel size in degrees

    # GeoTIFF convention: row 0 = north → flip lat axis
    # lats is ascending (index 0 = southernmost), so reverse for raster order
    west  = float(lons[0])  - cell / 2
    north = float(lats[-1]) + cell / 2   # lats[-1] = northernmost centre

    # bbox label for filenames
    def fmt_lat(v): return f'{abs(v):.1f}{"N" if v >= 0 else "S"}'
    def fmt_lon(v): return f'{abs(v):.1f}{"E" if v >= 0 else "W"}'
    bbox_label = f'{fmt_lat(min_lat)}-{fmt_lat(max_lat)}_{fmt_lon(min_lon)}-{fmt_lon(max_lon)}'

    with zipfile.ZipFile(out_zip, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for yr in unique_years:
            t_idxs = [i for i, y in enumerate(years_all) if y == yr]
            if not t_idxs:
                continue

            # Annual mean, flip rows to north→south
            subset = data[t_idxs, :, :]            # (T, nR, nC)
            annual = np.nanmean(subset, axis=0)     # (nR, nC), south→north
            annual = annual[::-1, :]                # flip → north→south for GeoTIFF
            annual[np.isnan(annual)] = -9999.0
            annual = annual.astype(np.float32)

            tif_bytes = write_geotiff(annual, west, north, cell, nodata=-9999.0)
            zf.writestr(f'GRACE_LWE_{yr}_{bbox_label}.tif', tif_bytes)

        readme = (
            f'GRACE LWE Annual Mean GeoTIFFs\n'
            f'==============================\n'
            f'Source:     JPL GRACE/GRACE-FO Mascon RL06.3 CRI-filtered\n'
            f'Units:      cm equivalent water height (LWE)\n'
            f'CRS:        WGS84 (EPSG:4326)\n'
            f'Pixel size: 0.5° x 0.5° (~55 km at equator)\n'
            f'Note:       Native mascon footprint is ~300 km; the 0.5° grid\n'
            f'            is JPL\'s distribution format — adjacent pixels often\n'
            f'            share the same value within one mascon.\n'
            f'Bbox:       {min_lat}°–{max_lat}° lat, {min_lon}°–{max_lon}° lon\n'
            f'NoData:     -9999.0\n'
            f'Years:      {min(unique_years)}–{max(unique_years)}\n\n'
            f'Each file:  GRACE_LWE_<year>_<bbox>.tif\n'
            f'            Annual mean of all valid monthly observations.\n\n'
            f'Generated by GRACE-TC-Geology Explorer\n'
        )
        zf.writestr('README.txt', readme)

    print(f'OK:{out_zip}:{len(unique_years)} years:{nR}x{nC} pixels')


if __name__ == '__main__':
    main()
