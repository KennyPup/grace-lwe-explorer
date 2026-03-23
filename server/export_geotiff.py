#!/usr/bin/env python3
"""
Generate annual mean GRACE LWE GeoTIFFs clipped to a bounding box.
Pure Python — no GDAL/rasterio dependency, works on any platform.

Usage:
  python3 export_geotiff.py <bin_file> <meta_json> <minLat> <maxLat> <minLon> <maxLon> <out_zip>
"""
import sys, json, zipfile, io, struct, math
import numpy as np
from datetime import datetime, timedelta


# ── Minimal GeoTIFF writer (pure Python, no GDAL/rasterio) ──────────────────
# Writes a valid single-band float32 GeoTIFF with GeoKeyDirectory and
# ModelTiepointTag / ModelPixelScaleTag so QGIS/ArcGIS reads it correctly.

def _pack(fmt, *args):
    return struct.pack(fmt, *args)

def _u16(v):  return _pack('<H', v)
def _u32(v):  return _pack('<I', v)
def _f64(v):  return _pack('<d', v)
def _i32(v):  return _pack('<i', v)
def _f32(v):  return _pack('<f', v)

def write_geotiff(data2d, west, north, cell_deg, nodata=-9999.0,
                  tags=None):
    """
    data2d : numpy float32 array, shape (nrows, ncols), top-row = north
    west   : left edge longitude (degrees)
    north  : top  edge latitude  (degrees)
    cell_deg: pixel size in degrees (square pixels assumed)
    Returns bytes of a valid GeoTIFF.
    """
    nrows, ncols = data2d.shape
    buf = io.BytesIO()

    # Replace NaN with nodata
    d = data2d.copy().astype(np.float32)
    d[np.isnan(d)] = nodata

    image_bytes = d.tobytes()          # row-major, float32 LE
    image_size  = len(image_bytes)

    # ── TIFF structure ──────────────────────────────────────────────────────
    # Header: 8 bytes
    # IFD offset stored at byte 4
    # We'll write: header | image_data | geo_doubles | geo_shorts | IFD

    HEADER_SIZE  = 8
    image_offset = HEADER_SIZE          # image data right after header

    # ModelPixelScaleTag: 3 doubles (scalex, scaley, scalez)
    pix_scale = struct.pack('<3d', cell_deg, cell_deg, 0.0)
    pix_scale_offset = image_offset + image_size
    pix_scale_size   = len(pix_scale)

    # ModelTiepointTag: 6 doubles (i,j,k, x,y,z) — upper-left corner
    tiepoint = struct.pack('<6d', 0.0, 0.0, 0.0, west, north, 0.0)
    tiepoint_offset = pix_scale_offset + pix_scale_size
    tiepoint_size   = len(tiepoint)

    # GeoKeyDirectory: 4 shorts per key + 4-short header
    # Keys: GTModelTypeGeoKey=2 (geographic), GTRasterTypeGeoKey=1 (pixel-is-area),
    #       GeographicTypeGeoKey=4326 (WGS84)
    geokeys = struct.pack('<16H',
        1, 1, 0, 3,          # version, revision, minor, nkeys
        1024, 0, 1, 2,       # GTModelTypeGeoKey = ModelTypeGeographic
        1025, 0, 1, 1,       # GTRasterTypeGeoKey = RasterPixelIsArea
        2048, 0, 1, 4326,    # GeographicTypeGeoKey = EPSG:4326 WGS84
    )
    geokeys_offset = tiepoint_offset + tiepoint_size
    geokeys_size   = len(geokeys)

    # GDAL_NODATA tag value: ASCII string
    nodata_str = (f'{nodata:g}\x00').encode('ascii')
    nodata_offset = geokeys_offset + geokeys_size
    nodata_size   = len(nodata_str)

    # IFD starts after all the data blobs
    ifd_offset = nodata_offset + nodata_size

    # IFD entries (12 bytes each): tag(u16) type(u16) count(u32) value_or_offset(u32)
    # TIFF types: SHORT=3, LONG=4, RATIONAL=5, FLOAT=11, DOUBLE=12, ASCII=2
    BYTE=1; ASCII=2; SHORT=3; LONG=4; RATIONAL=5; SBYTE=6; FLOAT=11; DOUBLE=12; SLONG=9

    def ifd_entry(tag, typ, count, value_or_offset):
        return _u16(tag) + _u16(typ) + _u32(count) + _u32(value_or_offset)

    entries = [
        ifd_entry(256, SHORT,  1,     ncols),                    # ImageWidth
        ifd_entry(257, SHORT,  1,     nrows),                    # ImageLength
        ifd_entry(258, SHORT,  1,     32),                       # BitsPerSample = 32
        ifd_entry(259, SHORT,  1,     1),                        # Compression = none
        ifd_entry(262, SHORT,  1,     1),                        # PhotometricInterp = BlackIsZero
        ifd_entry(273, LONG,   1,     image_offset),             # StripOffsets
        ifd_entry(278, LONG,   1,     nrows),                    # RowsPerStrip = all rows
        ifd_entry(279, LONG,   1,     image_size),               # StripByteCounts
        ifd_entry(284, SHORT,  1,     1),                        # PlanarConfig = contiguous
        ifd_entry(339, SHORT,  1,     3),                        # SampleFormat = IEEE float
        ifd_entry(33550, DOUBLE, 3,   pix_scale_offset),         # ModelPixelScaleTag
        ifd_entry(33922, DOUBLE, 6,   tiepoint_offset),          # ModelTiepointTag
        ifd_entry(34736, DOUBLE, len(geokeys)//8, geokeys_offset), # GeoDoubleParamsTag (unused but needed)
        ifd_entry(34735, SHORT,  len(geokeys)//2, geokeys_offset), # GeoKeyDirectoryTag
        ifd_entry(42113, ASCII,  nodata_size, nodata_offset),    # GDAL_NODATA
    ]
    entries.sort(key=lambda e: struct.unpack('<H', e[:2])[0])  # IFD must be sorted by tag

    n_entries = len(entries)
    ifd_bytes = _u16(n_entries) + b''.join(entries) + _u32(0)  # 0 = no next IFD

    # ── Assemble file ────────────────────────────────────────────────────────
    buf.write(b'II')                    # little-endian
    buf.write(_u16(42))                 # TIFF magic
    buf.write(_u32(ifd_offset))         # offset to first IFD
    buf.write(image_bytes)
    buf.write(pix_scale)
    buf.write(tiepoint)
    buf.write(geokeys)
    buf.write(nodata_str)
    buf.write(ifd_bytes)

    return buf.getvalue()


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) != 8:
        print("Usage: export_geotiff.py <bin> <meta> <minLat> <maxLat> <minLon> <maxLon> <out_zip>",
              file=sys.stderr)
        sys.exit(1)

    bin_file  = sys.argv[1]
    meta_file = sys.argv[2]
    min_lat   = float(sys.argv[3])
    max_lat   = float(sys.argv[4])
    min_lon   = float(sys.argv[5])
    max_lon   = float(sys.argv[6])
    out_zip   = sys.argv[7]

    # Load metadata
    with open(meta_file) as f:
        meta = json.load(f)

    lats   = np.array(meta['lats'])
    lons   = np.array(meta['lons'])    # 0–360
    times  = np.array(meta['times'])
    nLat   = meta['nLat']
    nLon   = meta['nLon']
    nTime  = meta['nTime']
    fill   = meta['fillValue']

    lons_180 = np.where(lons > 180, lons - 360, lons)

    # Find grid indices within bbox
    lat_mask = (lats >= min_lat) & (lats <= max_lat)
    lon_mask = (lons_180 >= min_lon) & (lons_180 <= max_lon)
    lat_idxs = np.where(lat_mask)[0]
    lon_idxs = np.where(lon_mask)[0]

    if len(lat_idxs) == 0 or len(lon_idxs) == 0:
        print("No GRACE pixels found in bounding box", file=sys.stderr)
        sys.exit(2)

    cell = 0.5
    # GeoTIFF: rows go north→south, so reverse lat indices
    lat_idxs_rev = lat_idxs[::-1]
    west  = float(lons_180[lon_idxs[0]])  - cell / 2
    north = float(lats[lat_idxs[-1]])     + cell / 2

    out_nLat = len(lat_idxs)
    out_nLon = len(lon_idxs)

    # Parse times → year
    base = datetime(2002, 1, 1)
    def days_to_year(d):
        return (base + timedelta(days=float(d))).year
    years_all    = [days_to_year(t) for t in times]
    unique_years = sorted(set(years_all))

    # Load full binary
    with open(bin_file, 'rb') as f:
        raw = f.read()
    data = np.frombuffer(raw, dtype='<f4', count=nTime * nLat * nLon).reshape(nTime, nLat, nLon).astype(np.float32)
    data[np.abs(data - fill) < 1.0] = np.nan

    # bbox label
    def fmt_lat(v): return f'{abs(v):.1f}{"N" if v >= 0 else "S"}'
    def fmt_lon(v): return f'{abs(v):.1f}{"E" if v >= 0 else "W"}'
    bbox_label = f'{fmt_lat(min_lat)}-{fmt_lat(max_lat)}_{fmt_lon(min_lon)}-{fmt_lon(max_lon)}'

    with zipfile.ZipFile(out_zip, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for yr in unique_years:
            t_idxs = [i for i, y in enumerate(years_all) if y == yr]
            if not t_idxs:
                continue

            subset = data[np.ix_(t_idxs, lat_idxs_rev, lon_idxs)]  # (T, rows, cols) north→south
            annual = np.nanmean(subset, axis=0).astype(np.float32)
            annual[np.isnan(annual)] = -9999.0

            tif_bytes = write_geotiff(annual, west, north, cell, nodata=-9999.0)
            zf.writestr(f'GRACE_LWE_{yr}_{bbox_label}.tif', tif_bytes)

        # README
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

    print(f'OK:{out_zip}:{len(unique_years)} years:{out_nLat}x{out_nLon} pixels')


if __name__ == '__main__':
    main()
