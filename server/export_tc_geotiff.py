#!/usr/bin/env python3
"""
Generate annual mean TerraClimate GeoTIFFs from pre-fetched data.
Pure Python — no GDAL/rasterio dependency.

Reads JSON from stdin (provided by Node from cached TC results).
Writes one GeoTIFF per variable per year into a zip file.

For a POINT query : 1×1 pixel GeoTIFF at the TC grid cell (~4.6 km)
For a BBOX query  : grid of pixels covering the bbox, each holding the
                    spatial mean for that year (consistent with chart display)

Usage:
  echo '<json>' | python3 export_tc_geotiff.py <out_zip>

JSON schema:
  {
    mode:      'point' | 'bbox'
    lat:       float          (point only — TC grid centre)
    lon:       float          (point only)
    bbox:      {minLat, maxLat, minLon, maxLon}  (bbox only)
    variables: {
      ppt: { annual: [{year, value}, ...], monthly_means: [float|null, ...] × 12 },
      aet: { annual: [...],               monthly_means: [...] },
      q:   { annual: [...],               monthly_means: [...] }
    }
  }

Output zip contains:
  TC_<VAR>_<year>_<loc>.tif   — one per variable per year (annual total, mm/yr)
  TC_<VAR>_MonthlyMean_<mon>_<loc>.tif — climatological mean for each calendar month
  README.txt
"""
import sys, json, zipfile, io, struct, math
import numpy as np
from datetime import datetime


# ── Variable metadata ──────────────────────────────────────────────────────
VAR_META = {
    'ppt': {'long_name': 'Precipitation',          'units': 'mm/year'},
    'aet': {'long_name': 'Actual Evapotranspiration', 'units': 'mm/year'},
    'q':   {'long_name': 'Runoff',                 'units': 'mm/year'},
}

# Human-readable label used in filenames
VAR_LABEL = {'ppt': 'PPT', 'aet': 'AET', 'q': 'Runoff', 'bf': 'BF'}

TC_RES   = 1 / 24   # ~0.04167° per pixel (~4.6 km)
LAT_MAX  =  89.97916667
LON_MIN  = -179.97916667


# ── Pure-Python GeoTIFF writer (identical logic to GRACE exporter) ──────────

def write_geotiff(data2d, west, north, cell_deg, nodata=-9999.0):
    """
    data2d   : float32 array (nrows, ncols), row 0 = northernmost
    Returns  : bytes of a valid GeoTIFF (WGS84 EPSG:4326)
    """
    nrows, ncols = data2d.shape
    d = data2d.copy().astype(np.float32)
    d[np.isnan(d)] = nodata
    image_bytes = d.tobytes()
    image_size  = len(image_bytes)

    image_offset    = 8
    pix_scale       = struct.pack('<3d', cell_deg, cell_deg, 0.0)
    tiepoint        = struct.pack('<6d', 0.0, 0.0, 0.0, west, north, 0.0)
    geokeys = struct.pack('<16H',
        1, 1, 0, 3,
        1024, 0, 1, 2,     # GTModelTypeGeoKey = Geographic
        1025, 0, 1, 1,     # GTRasterTypeGeoKey = PixelIsArea
        2048, 0, 1, 4326,  # GeographicTypeGeoKey = WGS84
    )
    nodata_str = f'{nodata:g}\x00'.encode('ascii')

    pix_scale_offset = image_offset + image_size
    tiepoint_offset  = pix_scale_offset + len(pix_scale)
    geokeys_offset   = tiepoint_offset  + len(tiepoint)
    nodata_offset    = geokeys_offset   + len(geokeys)
    ifd_offset       = nodata_offset    + len(nodata_str)

    SHORT=3; LONG=4; DOUBLE=12; ASCII=2
    def entry(tag, typ, count, val):
        return struct.pack('<HHII', tag, typ, count, val)

    entries = sorted([
        entry(256,   SHORT,  1,               ncols),
        entry(257,   SHORT,  1,               nrows),
        entry(258,   SHORT,  1,               32),
        entry(259,   SHORT,  1,               1),
        entry(262,   SHORT,  1,               1),
        entry(273,   LONG,   1,               image_offset),
        entry(278,   LONG,   1,               nrows),
        entry(279,   LONG,   1,               image_size),
        entry(284,   SHORT,  1,               1),
        entry(339,   SHORT,  1,               3),          # float
        entry(33550, DOUBLE, 3,               pix_scale_offset),
        entry(33922, DOUBLE, 6,               tiepoint_offset),
        entry(34735, SHORT,  len(geokeys)//2, geokeys_offset),
        entry(42113, ASCII,  len(nodata_str), nodata_offset),
    ], key=lambda e: struct.unpack('<H', e[:2])[0])

    n_entries = len(entries)
    ifd_bytes = struct.pack('<H', n_entries) + b''.join(entries) + struct.pack('<I', 0)

    buf = io.BytesIO()
    buf.write(b'II')
    buf.write(struct.pack('<H', 42))
    buf.write(struct.pack('<I', ifd_offset))
    buf.write(image_bytes)
    buf.write(pix_scale)
    buf.write(tiepoint)
    buf.write(geokeys)
    buf.write(nodata_str)
    buf.write(ifd_bytes)
    return buf.getvalue()


def snap_to_tc_grid(val, is_lat):
    """Snap a coordinate to the nearest TC grid cell centre."""
    if is_lat:
        idx = round((LAT_MAX - val) / TC_RES)
        return LAT_MAX - idx * TC_RES
    else:
        while val > 180: val -= 360
        while val < -180: val += 360
        idx = round((val - LON_MIN) / TC_RES)
        return LON_MIN + idx * TC_RES


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) != 2:
        print("Usage: echo '<json>' | python3 export_tc_geotiff.py <out_zip>",
              file=sys.stderr)
        sys.exit(1)

    out_zip = sys.argv[1]
    payload = json.loads(sys.stdin.read())

    mode      = payload['mode']           # 'point' or 'bbox'
    variables = payload['variables']      # {ppt:{annual:[...]}, aet:{...}, q:{...}}

    # ── Determine grid extent ────────────────────────────────────────────────
    if mode == 'point':
        # Single TC pixel: snap to grid centre
        lat_c = snap_to_tc_grid(payload['lat'], is_lat=True)
        lon_c = snap_to_tc_grid(payload['lon'], is_lat=False)
        west  = lon_c - TC_RES / 2
        north = lat_c + TC_RES / 2
        nrows, ncols = 1, 1
        bbox_label = f'{abs(lat_c):.4f}{"N" if lat_c>=0 else "S"}_{abs(lon_c):.4f}{"E" if lon_c>=0 else "W"}'
        loc_desc = f'Point: {lat_c:.4f}°{"N" if lat_c>=0 else "S"}, {lon_c:.4f}°{"E" if lon_c>=0 else "W"}'
    else:
        # Bbox: fill grid with mean value
        bb = payload['bbox']
        min_lat, max_lat = bb['minLat'], bb['maxLat']
        min_lon, max_lon = bb['minLon'], bb['maxLon']

        # Snap edges to TC grid
        lat_top  = snap_to_tc_grid(max_lat, is_lat=True)   # northernmost centre
        lat_bot  = snap_to_tc_grid(min_lat, is_lat=True)   # southernmost centre
        lon_left = snap_to_tc_grid(min_lon, is_lat=False)
        lon_right= snap_to_tc_grid(max_lon, is_lat=False)

        west  = lon_left  - TC_RES / 2
        north = lat_top   + TC_RES / 2
        nrows = round((lat_top - lat_bot)  / TC_RES) + 1
        ncols = round((lon_right - lon_left) / TC_RES) + 1
        nrows = max(1, nrows)
        ncols = max(1, ncols)

        def fmt_lat(v): return f'{abs(v):.1f}{"N" if v>=0 else "S"}'
        def fmt_lon(v): return f'{abs(v):.1f}{"E" if v>=0 else "W"}'
        bbox_label = f'{fmt_lat(min_lat)}-{fmt_lat(max_lat)}_{fmt_lon(min_lon)}-{fmt_lon(max_lon)}'
        loc_desc = f'Bbox mean: {min_lat}°–{max_lat}° lat, {min_lon}°–{max_lon}° lon'

    cell_deg = TC_RES

    # ── Collect all years present across all variables ───────────────────────
    all_years = set()
    for vdata in variables.values():
        for rec in vdata.get('annual', []):
            if rec.get('value') is not None:
                all_years.add(int(rec['year']))
    unique_years = sorted(all_years)

    if not unique_years:
        print("No valid annual data found", file=sys.stderr)
        sys.exit(2)

    # Build year→value lookup per variable
    var_annual = {}
    for vname, vdata in variables.items():
        var_annual[vname] = {int(r['year']): r['value']
                             for r in vdata.get('annual', [])
                             if r.get('value') is not None}

    # ── Build monthly-mean lookup per variable ───────────────────────────────
    # monthly_means: list of 12 floats (Jan=0 … Dec=11), climatological mean
    MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun',
                   'Jul','Aug','Sep','Oct','Nov','Dec']
    var_monthly_means = {}
    for vname, vdata in variables.items():
        mm = vdata.get('monthly_means', [])
        if mm and len(mm) == 12:
            var_monthly_means[vname] = mm

    # ── Write zip ────────────────────────────────────────────────────────────
    total_files = 0
    with zipfile.ZipFile(out_zip, 'w', compression=zipfile.ZIP_DEFLATED) as zf:

        # ── Annual TIFFs ─────────────────────────────────────────────────────
        for vname in ['ppt', 'aet', 'q']:
            if vname not in var_annual:
                continue

            for yr in unique_years:
                val = var_annual[vname].get(yr)
                if val is None:
                    continue

                # Fill grid: all pixels = the annual value (or spatial mean for bbox)
                grid = np.full((nrows, ncols), val, dtype=np.float32)
                tif_bytes = write_geotiff(grid, west, north, cell_deg, nodata=-9999.0)

                fname = f'annual/TC_{VAR_LABEL.get(vname, vname.upper())}_{yr}_{bbox_label}.tif'
                zf.writestr(fname, tif_bytes)
                total_files += 1

        # ── Monthly-mean climatology TIFFs (Jan–Dec) ─────────────────────────
        for vname in ['ppt', 'aet', 'q']:
            if vname not in var_monthly_means:
                continue
            mm_vals = var_monthly_means[vname]  # list of 12 floats|None

            for m_idx, val in enumerate(mm_vals):
                if val is None:
                    continue
                mon_name = MONTH_NAMES[m_idx]       # e.g. 'Jan'
                mon_num  = f'{m_idx+1:02d}'          # e.g. '01'

                grid = np.full((nrows, ncols), val, dtype=np.float32)
                tif_bytes = write_geotiff(grid, west, north, cell_deg, nodata=-9999.0)

                fname = f'monthly_means/TC_{VAR_LABEL.get(vname, vname.upper())}_MeanMonthly_{mon_num}_{mon_name}_{bbox_label}.tif'
                zf.writestr(fname, tif_bytes)
                total_files += 1

        # ── Baseflow monthly-mean TIFFs (P − AET − Q, floored at 0) ─────────
        ppt_mm = var_monthly_means.get('ppt', [None]*12)
        aet_mm = var_monthly_means.get('aet', [None]*12)
        q_mm   = var_monthly_means.get('q',   [None]*12)
        bf_mm  = []
        if len(ppt_mm) == 12 and len(aet_mm) == 12 and len(q_mm) == 12:
            for m_idx in range(12):
                p, a, q = ppt_mm[m_idx], aet_mm[m_idx], q_mm[m_idx]
                if p is None or a is None or q is None:
                    bf_mm.append(None)
                    continue
                bf_val = max(0.0, p - a - q)
                bf_mm.append(bf_val)
                mon_name = MONTH_NAMES[m_idx]
                mon_num  = f'{m_idx+1:02d}'

                grid = np.full((nrows, ncols), bf_val, dtype=np.float32)
                tif_bytes = write_geotiff(grid, west, north, cell_deg, nodata=-9999.0)

                fname = f'monthly_means/TC_BF_MeanMonthly_{mon_num}_{mon_name}_{bbox_label}.tif'
                zf.writestr(fname, tif_bytes)
                total_files += 1

        # ── Annual-mean TIFFs (sum of monthly_means ÷ 12) ────────────────────────
        # One TIF per variable (ppt/aet/q/bf) representing the climatological
        # annual mean derived from the 12 monthly mean values.
        def mm_annual_mean(vals):
            valid = [v for v in vals if v is not None]
            return sum(valid) / len(valid) if valid else None

        annual_means_out = {
            'PPT':    mm_annual_mean(ppt_mm),
            'AET':    mm_annual_mean(aet_mm),
            'Runoff': mm_annual_mean(q_mm),
            'BF':     mm_annual_mean(bf_mm) if bf_mm else None,
        }
        for label, val in annual_means_out.items():
            if val is None:
                continue
            grid = np.full((nrows, ncols), val, dtype=np.float32)
            tif_bytes = write_geotiff(grid, west, north, cell_deg, nodata=-9999.0)
            fname = f'monthly_means/TC_{label}_AnnualMean_{bbox_label}.tif'
            zf.writestr(fname, tif_bytes)
            total_files += 1

        # README
        readme_lines = [
            'TerraClimate GeoTIFFs — Annual + Monthly Climatology',
            '=====================================================',
            'Source:     TerraClimate (Abatzoglou et al. 2018), THREDDS OPeNDAP',
            f'Variables:  ppt = Precipitation (mm)',
            f'            aet = Actual Evapotranspiration (mm)',
            f'            q   = Runoff (mm)',
            f'            bf  = Baseflow (mm) = max(0, ppt − aet − q)',
            f'                  (monthly_means folder only; floored at zero)',
            f'CRS:        WGS84 (EPSG:4326)',
            f'Pixel size: {TC_RES:.6f}° (~4.6 km)',
            f'Location:   {loc_desc}',
        ]
        if mode == 'bbox':
            readme_lines += [
                '',
                'Note: Each pixel in a bbox GeoTIFF holds the spatial mean',
                'over all TC grid cells within the drawn rectangle.',
                'This matches the values shown in the app charts.',
                'For per-pixel spatial data, query individual points.',
            ]
        readme_lines += [
            '',
            f'NoData:     -9999.0',
            f'Years:      {min(unique_years)}–{max(unique_years)}',
            '',
            'Folder structure:',
            '  annual/           — one TIF per variable per year (annual total mm)',
            '  monthly_means/    — 12 TIFs per variable per calendar month + 4 annual-mean TIFs',
            '                      (PPT/AET/Runoff/BF each have Jan–Dec means + 1 overall annual mean)',
            '',
            'File naming:',
            '  annual/         TC_<VAR>_<year>_<location>.tif  (VAR = PPT/AET/Runoff)',
            '  monthly_means/  TC_<VAR>_MeanMonthly_<MM>_<Mon>_<location>.tif  (VAR = PPT/AET/Runoff/BF)',
            '  monthly_means/  TC_<VAR>_AnnualMean_<location>.tif  — mean of 12 monthly means',
            '',
            'Generated by GRACE-TC-Geology Explorer',
        ]
        zf.writestr('README.txt', '\n'.join(readme_lines))

    n_annual_files = sum(len(var_annual.get(v, {})) for v in ['ppt','aet','q'])
    n_mm_files     = sum(12 for v in ['ppt','aet','q'] if v in var_monthly_means)
    print(f'OK:{out_zip}:{len(unique_years)} years:{total_files} files:{nrows}x{ncols} pixels')


if __name__ == '__main__':
    main()
