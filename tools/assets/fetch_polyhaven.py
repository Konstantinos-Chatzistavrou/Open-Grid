#!/usr/bin/env python3
"""Fetch Poly Haven kit masters through the official API (docs/kit.md), with a licence ledger each.

    python3 tools/assets/fetch_polyhaven.py hdri <id> [<id> ...]

For each asset:
  1. the official API record (https://api.polyhaven.com/info/<id>) gives the name and authors;
  2. the licence is READ from https://polyhaven.com/license on the day (the API record has no licence field); the run
     stops if that page no longer states that the assets are CC0;
  3. the master is the largest file within the per-file budget (data/asset_budgets.json `maxFileMB`, else 50 MB),
     EXR preferred over HDR at the same resolution; its MD5 is checked against the API's;
  4. assets_source/masters/kit/<id>/: the master, source.json (the ledger) and evidence/ (API record, licence text).
API terms (https://github.com/Poly-Haven/Public-API/blob/master/ToS.md): every call carries a user agent naming
OpenGrid; requests are sequential with a pause between them.
"""
import datetime
import hashlib
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
KIT = os.path.join(ROOT, "assets_source", "masters", "kit")
UA = {"User-Agent": "OpenGrid/1.0 (kit v1 asset pipeline; https://github.com/Konstantinos-Chatzistavrou/Open-Grid)"}
LICENCE_PAGE = "https://polyhaven.com/license"
PAUSE = 1.0


def get(url, binary=False):
    time.sleep(PAUSE)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


def budget_mb():
    p = os.path.join(ROOT, "data", "asset_budgets.json")
    if os.path.exists(p):
        return float(json.load(open(p)).get("maxFileMB", 50))
    return 50.0


def licence_text():
    html = get(LICENCE_PAGE)
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))
    m = re.search(r"Asset License(.{0,900})", text)
    excerpt = (m.group(0) if m else text[:1200]).strip()
    if "licensed as CC0" not in excerpt:
        sys.exit(f"STOP: {LICENCE_PAGE} no longer says 'licensed as CC0' - read it and decide by hand")
    return excerpt


def pick(files, kind, limit):
    """largest resolution whose file fits the budget; EXR before HDR"""
    best = None
    for res in sorted(files[kind], key=lambda r: int(r[:-1])):
        for fmt in ("exr", "hdr"):
            f = files[kind][res].get(fmt)
            if f and f["size"] <= limit * 1048576:
                cand = (int(res[:-1]), fmt == "exr", res, fmt, f)
                if best is None or cand[:2] > best[:2]:
                    best = cand
    if best is None:
        sys.exit("no file within the budget")
    return best[2], best[3], best[4]


def main():
    kind, ids = sys.argv[1], sys.argv[2:]
    if kind != "hdri" or not ids:
        sys.exit(__doc__)
    limit = budget_mb()
    lic = licence_text()
    today = datetime.date.today().isoformat()
    for aid in ids:
        info = json.loads(get(f"https://api.polyhaven.com/info/{aid}"))
        files = json.loads(get(f"https://api.polyhaven.com/files/{aid}"))
        res, fmt, f = pick(files, "hdri", limit)
        folder = os.path.join(KIT, aid)
        os.makedirs(os.path.join(folder, "evidence"), exist_ok=True)
        name = f"{aid}_{res}.{fmt}"
        path = os.path.join(folder, name)
        if not (os.path.exists(path) and hashlib.md5(open(path, "rb").read()).hexdigest() == f["md5"]):
            data = get(f["url"], binary=True)
            if hashlib.md5(data).hexdigest() != f["md5"]:
                sys.exit(f"{aid}: MD5 mismatch for {f['url']}")
            with open(path, "wb") as out:
                out.write(data)
        all_res = sorted(files["hdri"], key=lambda r: int(r[:-1]))
        json.dump(info, open(os.path.join(folder, "evidence", "polyhaven_info.json"), "w"), indent=1, ensure_ascii=False)
        open(os.path.join(folder, "evidence", "polyhaven_license.txt"), "w").write(f"{LICENCE_PAGE} read {today}:\n\n{lic}\n")
        authors = ", ".join(f"{a} ({r})" if r != "All" else a for a, r in info.get("authors", {}).items())
        ledger = {
            "name": info.get("name", aid),
            "url": f"https://polyhaven.com/a/{aid}",
            "author": authors,
            "licence": "CC0-1.0",
            "licence_url": LICENCE_PAGE,
            "downloaded": today,
            "files": [name],
            "notes": (f"Poly Haven HDRI, {res.upper()} {fmt.upper()} ({f['size'] / 1048576:.1f} MB, MD5 {f['md5']} checked) through the "
                      f"official API. Licence read {today} from {LICENCE_PAGE} (all Poly Haven assets CC0; evidence/). "
                      f"The source goes up to {all_res[-1].upper()}; larger files are over the {limit:g} MB per-file budget."),
        }
        json.dump(ledger, open(os.path.join(folder, "source.json"), "w"), indent=2, ensure_ascii=False)
        open(os.path.join(folder, "source.json"), "a").write("\n")
        print(f"{aid}: {name} ({f['size'] / 1048576:.1f} MB), authors {authors}")


if __name__ == "__main__":
    main()
