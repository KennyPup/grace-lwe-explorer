"""
Pre-process the GRACE netCDF into a compact binary+JSON format for fast Node.js consumption.
Outputs:
  data/grace_meta.json   — lats, lons, times arrays + dimensions
  data/grace_lwe.bin     — float32 binary blob: [nTime * nLat * nLon] flat array
"""
import netCDF4 as nc
import numpy as np
import json
import struct
import os

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
NC_FILE = os.path.join(DATA_DIR, "grace_mascon.nc")
META_FILE = os.path.join(DATA_DIR, "grace_meta.json")
BIN_FILE = os.path.join(DATA_DIR, "grace_lwe.bin")

print("Opening GRACE netCDF...")
ds = nc.Dataset(NC_FILE)

lats = ds.variables['lat'][:].tolist()
lons = ds.variables['lon'][:].tolist()
times = ds.variables['time'][:].tolist()
fill_val = float(ds.variables['lwe_thickness']._FillValue)
time_units = ds.variables['time'].units

print(f"Dimensions: {len(times)} times x {len(lats)} lats x {len(lons)} lons")

# Read lwe_thickness and replace fill values with NaN → write as float32
# Shape: (nTime, nLat, nLon)
print("Reading lwe_thickness array...")
lwe = ds.variables['lwe_thickness'][:].data.astype(np.float32)
lwe[lwe == fill_val] = np.nan

print(f"LWE range (ignoring NaN): {np.nanmin(lwe):.3f} to {np.nanmax(lwe):.3f} cm")

# Write binary flat array (C order: time-major)
print(f"Writing binary file ({lwe.nbytes / 1024 / 1024:.1f} MB)...")
lwe_flat = lwe.flatten()
with open(BIN_FILE, 'wb') as f:
    f.write(lwe_flat.tobytes())

# Write metadata JSON
meta = {
    "nTime": len(times),
    "nLat": len(lats),
    "nLon": len(lons),
    "lats": lats,
    "lons": lons,
    "times": times,   # days since 2002-01-01
    "timeUnits": time_units,
    "fillValue": fill_val,
    "units": "cm",
    "source": "JPL GRACE/GRACE-FO Mascon RL06.3 CRI-filtered"
}
with open(META_FILE, 'w') as f:
    json.dump(meta, f)

ds.close()
print(f"Done. meta={META_FILE}, bin={BIN_FILE} ({os.path.getsize(BIN_FILE)/1024/1024:.1f} MB)")
