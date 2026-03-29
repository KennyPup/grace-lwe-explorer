#!/usr/bin/env python3
"""
TerraClimate data fetcher via THREDDS OPeNDAP subsetting.
Usage:
  python fetch_terraclimate.py point <lat> <lon>
  python fetch_terraclimate.py bbox <minLat> <maxLat> <minLon> <maxLon>

Outputs JSON to stdout.
Variables: ppt (precip, mm), aet (actual ET, mm), ro (runoff, mm)
Years: 2002–2025 (matching GRACE range)
Resolution: ~4km (1/24°), monthly values

NOTE: netCDF4 auto-applies scale_factor & add_offset when reading.
We use set_auto_maskandscale(True) (default) so returned arrays are
already in physical units (mm). Masked values (fill) are numpy.ma.masked.
"""

import sys
import json
import os
import time

# TerraClimate THREDDS OPeNDAP base URL
BASE_URL = "http://thredds.northwestknowledge.net/thredds/dodsC/TERRACLIMATE_ALL/data/TerraClimate_{var}_{year}.nc"

VARS = ["ppt", "aet", "q"]   # q = runoff (TerraClimate uses 'q' not 'ro')
START_YEAR = 2002
END_YEAR = 2025

# TerraClimate grid: 1/24° resolution
# lat[i] = 89.97916667 - i * (1/24), lon[j] = -179.97916667 + j * (1/24)
TC_RES = 1.0 / 24.0
LAT_MAX = 89.97916667
LON_MIN = -179.97916667
NLAT = 4320
NLON = 8640

def lat_to_idx(lat):
    idx = round((LAT_MAX - lat) / TC_RES)
    return max(0, min(NLAT - 1, idx))

def lon_to_idx(lon):
    # Normalize lon to -180..180
    while lon > 180: lon -= 360
    while lon < -180: lon += 360
    idx = round((lon - LON_MIN) / TC_RES)
    return max(0, min(NLON - 1, idx))

def safe_float(val):
    """Convert numpy masked or float to Python float or None."""
    try:
        import numpy as np
        if np.ma.is_masked(val):
            return None
        f = float(val)
        if f != f:  # NaN check
            return None
        return f
    except:
        return None

def fetch_point_year(var, year, lat_idx, lon_idx, retries=3):
    """Fetch 12 monthly values for a single lat/lon point and year via OPeNDAP.
    netCDF4 auto-scales, so returned values are in physical units."""
    from netCDF4 import Dataset
    
    url = BASE_URL.format(var=var, year=year)
    subset_url = f"{url}?{var}[0:11][{lat_idx}:{lat_idx}][{lon_idx}:{lon_idx}]"
    
    for attempt in range(retries):
        try:
            ds = Dataset(subset_url)
            v = ds.variables[var]
            # auto_maskandscale=True by default → returns masked array in physical units
            vals = v[:, 0, 0]  # shape (12,)
            ds.close()
            return [safe_float(x) for x in vals]
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise RuntimeError(f"Failed to fetch {var} {year}: {e}")

def fetch_bbox_year(var, year, lat_top_idx, lat_bot_idx, lon_left_idx, lon_right_idx, retries=3):
    """Fetch all grid cells within bbox for one year.
    Returns (monthly_means_list, spatial_3d_array) where spatial_3d_array has shape (12, nrows, ncols).
    """
    from netCDF4 import Dataset
    import numpy as np
    
    # row indices: lat_top_idx <= lat_bot_idx (top = north = smaller index)
    r0 = min(lat_top_idx, lat_bot_idx)
    r1 = max(lat_top_idx, lat_bot_idx)
    c0 = min(lon_left_idx, lon_right_idx)
    c1 = max(lon_left_idx, lon_right_idx)
    
    # Cap at 200 cells per dimension to avoid huge downloads
    r1 = min(r1, r0 + 199)
    c1 = min(c1, c0 + 199)
    
    url = BASE_URL.format(var=var, year=year)
    subset_url = f"{url}?{var}[0:11][{r0}:{r1}][{c0}:{c1}]"
    
    for attempt in range(retries):
        try:
            ds = Dataset(subset_url)
            v = ds.variables[var]
            vals = v[:, :, :]  # shape (12, nrows, ncols), auto-scaled masked array
            ds.close()
            
            monthly = []
            for m in range(12):
                month_data = vals[m, :, :]
                if hasattr(month_data, 'compressed'):
                    valid = month_data.compressed()
                else:
                    valid = month_data.flatten()
                if len(valid) > 0:
                    monthly.append(float(np.mean(valid)))
                else:
                    monthly.append(None)
            return monthly, vals  # also return raw 3D array
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise RuntimeError(f"Failed to fetch bbox {var} {year}: {e}")

def build_series(monthly_by_year):
    """
    Returns:
    - monthly_series: [{month: "YYYY-MM", value: float|None}, ...]
    - annual_series: [{year: int, value: float|None}, ...]  (sum of 12 months)
    - monthly_means: [float|None] × 12 (climatological mean for each calendar month)
    """
    monthly_series = []
    annual_series = []
    month_accum = [[] for _ in range(12)]
    
    for year in sorted(monthly_by_year.keys()):
        vals = monthly_by_year[year]
        for m_idx, v in enumerate(vals):
            monthly_series.append({"month": f"{year}-{m_idx+1:02d}", "value": v})
            if v is not None:
                month_accum[m_idx].append(v)
        valid = [v for v in vals if v is not None]
        # annual = sum of monthly values (total annual), not mean
        annual_series.append({"year": year, "value": sum(valid) if valid else None})
    
    monthly_means = []
    for m_idx in range(12):
        acc = month_accum[m_idx]
        monthly_means.append(sum(acc) / len(acc) if acc else None)
    
    return monthly_series, annual_series, monthly_means


def build_spatial_monthly_means(spatial_by_year):
    """
    Given a dict {year: ndarray(12, nrows, ncols)}, compute the climatological
    monthly mean for each pixel: output shape (12, nrows, ncols).
    Returns a nested list [month][row][col] = float|None  (north-to-south row order).
    Also returns (nrows, ncols, lat_bounds, lon_bounds) for the frontend.
    """
    import numpy as np
    
    if not spatial_by_year:
        return None, 0, 0
    
    # Stack years: shape (nyears, 12, nrows, ncols)
    years = sorted(spatial_by_year.keys())
    arrays = []
    ref_shape = None
    for yr in years:
        arr = spatial_by_year[yr]
        if ref_shape is None:
            ref_shape = arr.shape  # (12, nrows, ncols)
        # Convert masked array to float with NaN for masked values
        if hasattr(arr, 'filled'):
            arr_f = arr.filled(np.nan).astype(float)
        else:
            arr_f = np.array(arr, dtype=float)
        if arr_f.shape == ref_shape:
            arrays.append(arr_f)
    
    if not arrays:
        return None, 0, 0
    
    stacked = np.stack(arrays, axis=0)  # (nyears, 12, nrows, ncols)
    # Mean over years, ignoring NaN
    means = np.nanmean(stacked, axis=0)  # (12, nrows, ncols)
    
    nrows = means.shape[1]
    ncols = means.shape[2]
    
    # Convert to nested list: [month_idx][row][col] = float|None
    # Row 0 = northernmost (matches TC grid: top row = highest lat)
    result = []
    for m in range(12):
        row_list = []
        for r in range(nrows):
            col_list = []
            for c in range(ncols):
                v = float(means[m, r, c])
                col_list.append(None if (v != v) else v)  # NaN → None
            row_list.append(col_list)
        result.append(row_list)
    
    return result, nrows, ncols

def run_point(lat, lon):
    lat_idx = lat_to_idx(lat)
    lon_idx = lon_to_idx(lon)
    
    output = {"lat": lat, "lon": lon, "variables": {}}
    
    for var in VARS:
        monthly_by_year = {}
        errors = []
        for year in range(START_YEAR, END_YEAR + 1):
            try:
                monthly = fetch_point_year(var, year, lat_idx, lon_idx)
                monthly_by_year[year] = monthly
            except Exception as e:
                errors.append(f"{year}: {e}")
                monthly_by_year[year] = [None] * 12
        
        monthly_series, annual_series, monthly_means = build_series(monthly_by_year)
        output["variables"][var] = {
            "monthly": monthly_series,
            "annual": annual_series,
            "monthly_means": monthly_means,
        }
        if errors:
            output["variables"][var]["errors"] = errors
    
    return output

def run_bbox(minLat, maxLat, minLon, maxLon):
    # Convert to row/col indices
    # North (maxLat) → smaller row index (top of array)
    lat_top_idx = lat_to_idx(maxLat)
    lat_bot_idx = lat_to_idx(minLat)
    lon_left_idx = lon_to_idx(minLon)
    lon_right_idx = lon_to_idx(maxLon)
    
    output = {"bbox": {"minLat": minLat, "maxLat": maxLat, "minLon": minLon, "maxLon": maxLon}, "variables": {}}
    
    for var in VARS:
        monthly_by_year = {}   # year -> [12 scalar means]
        spatial_by_year = {}   # year -> ndarray(12, nrows, ncols)
        errors = []
        for year in range(START_YEAR, END_YEAR + 1):
            try:
                monthly, spatial = fetch_bbox_year(var, year, lat_top_idx, lat_bot_idx, lon_left_idx, lon_right_idx)
                monthly_by_year[year] = monthly
                spatial_by_year[year] = spatial
            except Exception as e:
                errors.append(f"{year}: {e}")
                monthly_by_year[year] = [None] * 12
        
        monthly_series, annual_series, monthly_means = build_series(monthly_by_year)
        
        # Build per-pixel climatological monthly means
        spatial_grid, nrows, ncols = build_spatial_monthly_means(spatial_by_year)
        
        output["variables"][var] = {
            "monthly": monthly_series,
            "annual": annual_series,
            "monthly_means": monthly_means,
        }
        # Only include spatial grid if it has multiple pixels (skip for single-pixel regions)
        if spatial_grid is not None and nrows * ncols > 1:
            output["variables"][var]["spatial_grid"] = spatial_grid
            output["variables"][var]["grid_shape"] = [nrows, ncols]
        if errors:
            output["variables"][var]["errors"] = errors
    
    return output

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: fetch_terraclimate.py point <lat> <lon> OR bbox <minLat> <maxLat> <minLon> <maxLon>"}))
        sys.exit(1)
    
    mode = sys.argv[1]
    try:
        if mode == "point":
            lat = float(sys.argv[2])
            lon = float(sys.argv[3])
            result = run_point(lat, lon)
        elif mode == "bbox":
            minLat = float(sys.argv[2])
            maxLat = float(sys.argv[3])
            minLon = float(sys.argv[4])
            maxLon = float(sys.argv[5])
            result = run_bbox(minLat, maxLat, minLon, maxLon)
        else:
            result = {"error": f"Unknown mode: {mode}"}
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
