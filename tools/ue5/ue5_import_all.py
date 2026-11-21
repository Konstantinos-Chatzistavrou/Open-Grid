#!/usr/bin/env python3
"""OpenGrid One-Click Unreal Engine 5.8 Editor Auto-Importer.

Idempotent UE 5.8 Editor Python script (`import unreal`) that imports all 24 cars,
modular aftermarket parts, 16 4K PBR Kit texture packs & HDRIs, the Tokyo Night
256x16 Color Grading LUT, UE5 DataTables, an unbound Tokyo Night PostProcessVolume,
and exported city Landscapes / PCG spline manifests in a single command.

Invocation:
  Headless CLI (recommended for bulk first-session import):
    UnrealEditor-Cmd.exe ue5/OpenGrid.uproject -ExecutePythonScript="tools/ue5/ue5_import_all.py"

  Interactive inside UE 5.8 Editor (Output Log -> Python console):
    py "tools/ue5/ue5_import_all.py"

Optional environment variables:
  OG_ONLY_CAR=falcorn_9r_rs       Import only specific car ID(s), comma-separated.
  OG_CITY=nyc                     Import/register only specific city ID(s), comma-separated
                                  (set to "none" or "skip" to skip cities).
  OG_SKIP_KIT=1                   Skip importing 4K PBR texture packs & HDRIs from ue5/SourceArt/Kit/.
  OG_USE_NANITE=1                 Prefer nanite_hero.glb (with Nanite enabled) over body.glb when present.
  OG_FORCE_REIMPORT=1             Re-import assets even if they already exist in /Game/OpenGrid/.

License: Apache-2.0
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

import unreal  # type: ignore[import-not-found]


# ---------------------------------------------------------------------------
# Configuration & helpers
# ---------------------------------------------------------------------------

CONTENT_ROOT = "/Game/OpenGrid"
CARS_CONTENT_ROOT = f"{CONTENT_ROOT}/Cars"
KIT_CONTENT_ROOT = f"{CONTENT_ROOT}/Kit"
POSTPROCESS_CONTENT_ROOT = f"{CONTENT_ROOT}/PostProcess"
DATA_CONTENT_ROOT = f"{CONTENT_ROOT}/Data"
CITIES_CONTENT_ROOT = f"{CONTENT_ROOT}/Cities"

WHEELS = ("FL", "FR", "RL", "RR")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff", ".exr", ".hdr"}
HDRI_EXTS = {".exr", ".hdr"}


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_list(name: str) -> Optional[List[str]]:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return None
    items = [item.strip() for item in raw.split(",") if item.strip()]
    return items or None


def _resolve_repo_root() -> str:
    """Resolve the OpenGrid repository root cleanly whether run via CLI or UE console."""
    if "__file__" in globals() and globals()["__file__"]:
        script_dir = os.path.dirname(os.path.abspath(globals()["__file__"]))
        candidate = os.path.abspath(os.path.join(script_dir, "..", ".."))
        if os.path.isdir(os.path.join(candidate, "ue5")):
            return candidate
    project_dir = os.path.abspath(unreal.Paths.project_dir())
    parent_dir = os.path.abspath(os.path.join(project_dir, ".."))
    if os.path.isdir(os.path.join(parent_dir, "data")) and os.path.isdir(
        os.path.join(parent_dir, "tools")
    ):
        return parent_dir
    return parent_dir


def _log(msg: str) -> None:
    unreal.log(f"[OpenGrid Import] {msg}")


def _warn(msg: str) -> None:
    unreal.log_warning(f"[OpenGrid Import] {msg}")


def _error(msg: str) -> None:
    unreal.log_error(f"[OpenGrid Import] {msg}")


def _enum_attr(enum_cls: Any, *names: str) -> Any:
    """Look up a UE Python enum value across naming conventions (e.g. TMGS_NoMipmaps vs TMGS_NO_MIPMAPS)."""
    if enum_cls is None:
        return None
    for name in names:
        if hasattr(enum_cls, name):
            return getattr(enum_cls, name)
        upper = name.upper()
        if hasattr(enum_cls, upper):
            return getattr(enum_cls, upper)
    return None


def _set_prop_any(obj: Any, prop_names: Iterable[str], value: Any) -> bool:
    """Safely set an Unreal editor property trying multiple candidate property names."""
    if obj is None or value is None:
        return False
    for name in prop_names:
        try:
            obj.set_editor_property(name, value)
            return True
        except Exception:
            continue
    return False


def _asset_exists(asset_path: str) -> bool:
    try:
        return bool(unreal.EditorAssetLibrary.does_asset_exist(asset_path))
    except Exception:
        return False


def _ensure_directory(content_dir: str) -> None:
    try:
        if not unreal.EditorAssetLibrary.does_directory_exist(content_dir):
            unreal.EditorAssetLibrary.make_directory(content_dir)
    except Exception:
        pass


def _sanitize_asset_name(name: str) -> str:
    """Sanitize a filename stem to a valid Unreal asset name."""
    out = []
    for ch in name:
        if ch.isalnum() or ch == "_":
            out.append(ch)
        else:
            out.append("_")
    cleaned = "".join(out).strip("_")
    return cleaned or "Asset"


# ---------------------------------------------------------------------------
# Mesh / glTF import (UE 5.8 InterchangeGenericAssetsPipeline + FbxImportUI fallback)
# ---------------------------------------------------------------------------

def _build_interchange_pipeline(
    import_morph_targets: bool = False,
    enable_nanite: bool = False,
    combine_meshes: bool = True,
) -> Any:
    """Build a configured UE 5.8 InterchangeGenericAssetsPipeline when available."""
    pipeline_cls = getattr(unreal, "InterchangeGenericAssetsPipeline", None)
    if pipeline_cls is None:
        return None

    try:
        pipeline = unreal.new_object(pipeline_cls)
    except Exception:
        try:
            pipeline = pipeline_cls()
        except Exception:
            return None

    _set_prop_any(pipeline, ("reimport_strategy",), _enum_attr(getattr(unreal, "EReimportStrategyFlags", None), "APPLY_NO_PROPERTIES"))
    _set_prop_any(pipeline, ("use_source_name_for_asset",), False)

    mesh_pipeline = None
    try:
        mesh_pipeline = pipeline.get_editor_property("mesh_pipeline")
    except Exception:
        mesh_pipeline = getattr(pipeline, "mesh_pipeline", None)

    if mesh_pipeline is not None:
        _set_prop_any(mesh_pipeline, ("combine_static_meshes",), combine_meshes)
        _set_prop_any(mesh_pipeline, ("import_static_meshes",), not import_morph_targets)
        _set_prop_any(mesh_pipeline, ("import_skeletal_meshes",), import_morph_targets)
        _set_prop_any(
            mesh_pipeline,
            ("import_morph_targets", "b_import_morph_targets"),
            import_morph_targets,
        )
        _set_prop_any(mesh_pipeline, ("build_nanite",), enable_nanite)
        _set_prop_any(mesh_pipeline, ("generate_lightmap_u_vs", "generate_lightmap_uvs"), False)
        _set_prop_any(mesh_pipeline, ("import_collision",), False)

    material_pipeline = None
    try:
        material_pipeline = pipeline.get_editor_property("material_pipeline")
    except Exception:
        material_pipeline = getattr(pipeline, "material_pipeline", None)
    if material_pipeline is not None:
        _set_prop_any(material_pipeline, ("import_materials",), True)

    texture_pipeline = None
    try:
        texture_pipeline = pipeline.get_editor_property("texture_pipeline")
    except Exception:
        texture_pipeline = getattr(pipeline, "texture_pipeline", None)
    if texture_pipeline is not None:
        _set_prop_any(texture_pipeline, ("import_textures",), True)

    return pipeline


def _build_legacy_mesh_options(
    import_morph_targets: bool = False,
    enable_nanite: bool = False,
    combine_meshes: bool = True,
) -> Any:
    """Fallback options object (FbxImportUI or standard glTF import options)."""
    # Prefer Interchange/glTF options if present, else FbxImportUI.
    fbx_ui_cls = getattr(unreal, "FbxImportUI", None)
    if fbx_ui_cls is None:
        return None

    ui = fbx_ui_cls()
    _set_prop_any(ui, ("automated_import_should_detect_type",), not import_morph_targets)
    _set_prop_any(ui, ("import_mesh",), True)
    _set_prop_any(ui, ("import_as_skeletal",), import_morph_targets)
    _set_prop_any(ui, ("import_materials",), True)
    _set_prop_any(ui, ("import_textures",), True)
    _set_prop_any(ui, ("import_animations",), False)

    if import_morph_targets:
        skel_data = getattr(ui, "skeletal_mesh_import_data", None)
        _set_prop_any(skel_data, ("import_morph_targets", "b_import_morph_targets"), True)
        _set_prop_any(skel_data, ("update_skeleton_reference_pose",), False)
    else:
        static_data = getattr(ui, "static_mesh_import_data", None)
        _set_prop_any(static_data, ("combine_meshes",), combine_meshes)
        _set_prop_any(static_data, ("build_nanite",), enable_nanite)
        _set_prop_any(static_data, ("auto_generate_collision",), False)

    return ui


def _post_process_imported_mesh(
    asset_path: str,
    enable_nanite: bool = False,
    sockets_ue_cm: Optional[Dict[str, List[float]]] = None,
) -> None:
    """Apply post-import Nanite toggle and ensure standardized OpenGrid sockets exist on body mesh."""
    asset = unreal.EditorAssetLibrary.load_asset(asset_path)
    if asset is None:
        return

    static_mesh_cls = getattr(unreal, "StaticMesh", None)
    if static_mesh_cls is not None and isinstance(asset, static_mesh_cls):
        changed = False
        if enable_nanite:
            try:
                nanite_settings = asset.get_editor_property("nanite_settings")
                if nanite_settings is not None:
                    nanite_settings.set_editor_property("enabled", True)
                    asset.set_editor_property("nanite_settings", nanite_settings)
                    changed = True
            except Exception as exc:
                _warn(f"Could not toggle Nanite on {asset_path}: {exc}")

        if sockets_ue_cm:
            socket_cls = getattr(unreal, "StaticMeshSocket", None)
            if socket_cls is not None:
                for sock_name, loc in sockets_ue_cm.items():
                    if not isinstance(loc, (list, tuple)) or len(loc) < 3:
                        continue
                    try:
                        existing = asset.find_socket(sock_name)
                        if existing is None:
                            sock = socket_cls(outer=asset)
                            sock.set_editor_property("socket_name", sock_name)
                            sock.set_editor_property(
                                "relative_location",
                                unreal.Vector(float(loc[0]), float(loc[1]), float(loc[2])),
                            )
                            asset.add_socket(sock)
                            changed = True
                    except Exception:
                        continue

        if changed:
            try:
                asset.post_edit_change()
            except Exception:
                pass


def _import_glb_mesh(
    source_file: str,
    dest_path: str,
    dest_name: str,
    import_morph_targets: bool = False,
    enable_nanite: bool = False,
    combine_meshes: bool = True,
    force_reimport: bool = False,
    sockets_ue_cm: Optional[Dict[str, List[float]]] = None,
) -> Tuple[bool, str]:
    """Import a single .glb mesh cleanly via AssetImportTask + InterchangeGenericAssetsPipeline (with fallback)."""
    asset_name = _sanitize_asset_name(dest_name)
    asset_path = f"{dest_path}/{asset_name}"
    if not force_reimport and _asset_exists(asset_path):
        return False, asset_path

    _ensure_directory(dest_path)

    # First attempt: UE 5.8 InterchangeManager scripted import with InterchangeGenericAssetsPipeline
    interchange_mgr_cls = getattr(unreal, "InterchangeManager", None)
    params_cls = getattr(unreal, "InterchangeImportAssetParameters", None)
    pipeline = _build_interchange_pipeline(
        import_morph_targets=import_morph_targets,
        enable_nanite=enable_nanite,
        combine_meshes=combine_meshes,
    )

    imported_via_interchange = False
    if interchange_mgr_cls is not None and params_cls is not None and pipeline is not None:
        try:
            mgr = interchange_mgr_cls.get_interchange_manager_scripted()
            source_data = interchange_mgr_cls.create_source_data(source_file)
            params = params_cls()
            _set_prop_any(params, ("is_automated",), True)
            _set_prop_any(params, ("replace_existing",), True)
            _set_prop_any(params, ("override_pipelines",), [unreal.SoftObjectPath(pipeline.get_path_name())] if hasattr(pipeline, "get_path_name") else [pipeline])
            if mgr.import_asset(dest_path, source_data, params):
                imported_via_interchange = True
        except Exception:
            imported_via_interchange = False

    # Primary / fallback path: AssetImportTask with InterchangeGenericAssetsPipeline or FbxImportUI options
    if not imported_via_interchange:
        task = unreal.AssetImportTask()
        task.filename = source_file
        task.destination_path = dest_path
        task.destination_name = asset_name
        task.replace_existing = True
        task.automated = True
        task.save = False

        if pipeline is not None:
            try:
                task.options = pipeline
            except Exception:
                task.options = _build_legacy_mesh_options(
                    import_morph_targets=import_morph_targets,
                    enable_nanite=enable_nanite,
                    combine_meshes=combine_meshes,
                )
        else:
            task.options = _build_legacy_mesh_options(
                import_morph_targets=import_morph_targets,
                enable_nanite=enable_nanite,
                combine_meshes=combine_meshes,
            )

        asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
        try:
            asset_tools.import_asset_tasks([task])
        except Exception:
            # Final fallback: standard glTF import options (no custom options object)
            task.options = None
            asset_tools.import_asset_tasks([task])

    _post_process_imported_mesh(
        asset_path,
        enable_nanite=enable_nanite,
        sockets_ue_cm=sockets_ue_cm,
    )
    return True, asset_path


# ---------------------------------------------------------------------------
# Step 1: Import all 24 cars + modular parts
# ---------------------------------------------------------------------------

def _discover_cars(repo_root: str, only_cars: Optional[List[str]]) -> List[str]:
    catalog_path = os.path.join(repo_root, "data", "cars", "catalog.json")
    car_ids: List[str] = []
    if os.path.isfile(catalog_path):
        with open(catalog_path, "r", encoding="utf-8") as f:
            catalog = json.load(f)
        car_ids = [c["id"] for c in catalog.get("cars", []) if "id" in c]
    else:
        import_root = os.path.join(repo_root, "ue5", "Import")
        if os.path.isdir(import_root):
            car_ids = sorted(
                d
                for d in os.listdir(import_root)
                if d != "Cities" and os.path.isdir(os.path.join(import_root, d))
            )

    if only_cars is not None:
        wanted = {c.lower() for c in only_cars}
        car_ids = [c for c in car_ids if c.lower() in wanted]
    return car_ids


def step_import_cars(
    repo_root: str,
    only_cars: Optional[List[str]],
    use_nanite: bool,
    force_reimport: bool,
) -> Dict[str, int]:
    stats = {"cars": 0, "bodies": 0, "wheels": 0, "calipers": 0, "wings": 0, "parts": 0, "skipped": 0}
    car_ids = _discover_cars(repo_root, only_cars)
    if not car_ids:
        _warn("No cars matched for import (check data/cars/catalog.json or OG_ONLY_CAR).")
        return stats

    _log(f"Step 1/7: Importing {len(car_ids)} car(s) (OG_USE_NANITE={int(use_nanite)})...")

    for car_id in car_ids:
        car_dir = os.path.join(repo_root, "ue5", "Import", car_id)
        if not os.path.isdir(car_dir):
            _warn(f"Skipping {car_id}: missing {car_dir} (run `node tools/ue5/export_cars_for_ue.mjs` first).")
            continue

        stats["cars"] += 1
        car_dest = f"{CARS_CONTENT_ROOT}/{car_id}"
        parts_dest = f"{car_dest}/Parts"

        # Load manifest for UE sockets if present
        sockets_ue_cm: Optional[Dict[str, List[float]]] = None
        manifest_path = os.path.join(car_dir, "manifest.json")
        if os.path.isfile(manifest_path):
            try:
                with open(manifest_path, "r", encoding="utf-8") as mf:
                    manifest = json.load(mf)
                sockets_ue_cm = manifest.get("sockets_ue_cm")
            except Exception as exc:
                _warn(f"Could not parse {manifest_path}: {exc}")

        # Body mesh: nanite_hero.glb when OG_USE_NANITE=1 and present, else body.glb with bImportMorphTargets=True
        nanite_glb = os.path.join(car_dir, "nanite_hero.glb")
        body_glb = os.path.join(car_dir, "body.glb")
        if use_nanite and os.path.isfile(nanite_glb):
            did_import, asset_path = _import_glb_mesh(
                source_file=nanite_glb,
                dest_path=car_dest,
                dest_name="nanite_hero",
                import_morph_targets=False,
                enable_nanite=True,
                combine_meshes=True,
                force_reimport=force_reimport,
                sockets_ue_cm=sockets_ue_cm,
            )
            _log(f"  [{car_id}] Nanite hero body -> {asset_path} ({'imported' if did_import else 'exists'})")
            stats["bodies" if did_import else "skipped"] += 1
        elif os.path.isfile(body_glb):
            did_import, asset_path = _import_glb_mesh(
                source_file=body_glb,
                dest_path=car_dest,
                dest_name="body",
                import_morph_targets=True,
                enable_nanite=False,
                combine_meshes=True,
                force_reimport=force_reimport,
                sockets_ue_cm=sockets_ue_cm,
            )
            _log(f"  [{car_id}] Body (morph targets) -> {asset_path} ({'imported' if did_import else 'exists'})")
            stats["bodies" if did_import else "skipped"] += 1
        else:
            _warn(f"  [{car_id}] Missing body.glb in {car_dir}")

        # Wheels & calipers
        for corner in WHEELS:
            wheel_glb = os.path.join(car_dir, f"wheel_{corner}.glb")
            if os.path.isfile(wheel_glb):
                did_import, _ = _import_glb_mesh(
                    source_file=wheel_glb,
                    dest_path=car_dest,
                    dest_name=f"wheel_{corner}",
                    import_morph_targets=False,
                    enable_nanite=use_nanite,
                    combine_meshes=True,
                    force_reimport=force_reimport,
                )
                stats["wheels" if did_import else "skipped"] += 1

            caliper_glb = os.path.join(car_dir, f"caliper_{corner}.glb")
            if os.path.isfile(caliper_glb):
                did_import, _ = _import_glb_mesh(
                    source_file=caliper_glb,
                    dest_path=car_dest,
                    dest_name=f"caliper_{corner}",
                    import_morph_targets=False,
                    enable_nanite=use_nanite,
                    combine_meshes=True,
                    force_reimport=force_reimport,
                )
                stats["calipers" if did_import else "skipped"] += 1

        # Optional stock wing
        wing_glb = os.path.join(car_dir, "stock_wing.glb")
        if os.path.isfile(wing_glb):
            did_import, _ = _import_glb_mesh(
                source_file=wing_glb,
                dest_path=car_dest,
                dest_name="stock_wing",
                import_morph_targets=False,
                enable_nanite=use_nanite,
                combine_meshes=True,
                force_reimport=force_reimport,
            )
            stats["wings" if did_import else "skipped"] += 1

        # Modular aftermarket parts (parts/*.glb)
        parts_dir = os.path.join(car_dir, "parts")
        if os.path.isdir(parts_dir):
            part_files = sorted(f for f in os.listdir(parts_dir) if f.lower().endswith(".glb"))
            for part_file in part_files:
                part_stem = os.path.splitext(part_file)[0]
                did_import, _ = _import_glb_mesh(
                    source_file=os.path.join(parts_dir, part_file),
                    dest_path=parts_dest,
                    dest_name=part_stem,
                    import_morph_targets=False,
                    enable_nanite=use_nanite,
                    combine_meshes=True,
                    force_reimport=force_reimport,
                )
                stats["parts" if did_import else "skipped"] += 1

    _log(
        f"Step 1/7 done: {stats['cars']} cars | imported {stats['bodies']} bodies, "
        f"{stats['wheels']} wheels, {stats['calipers']} calipers, {stats['wings']} stock wings, "
        f"{stats['parts']} modular parts ({stats['skipped']} already up to date)."
    )
    return stats


# ---------------------------------------------------------------------------
# Step 2: Import 4K PBR Kit texture packs & HDRIs
# ---------------------------------------------------------------------------

def _classify_kit_texture(filename: str) -> str:
    lower = filename.lower()
    ext = os.path.splitext(lower)[1]
    if ext in HDRI_EXTS:
        return "hdri"
    if any(tok in lower for tok in ("_normal", "_nrm", "_norm")):
        return "normal"
    if any(tok in lower for tok in ("_orm", "_arm", "_mask")):
        return "orm"
    if any(tok in lower for tok in ("_roughness", "_rough", "_metallic", "_metal", "_ao", "_occlusion", "_height", "_disp", "_bump")):
        return "linear_scalar"
    return "basecolor"


def _configure_texture_asset(asset_path: str, kind: str) -> None:
    tex = unreal.EditorAssetLibrary.load_asset(asset_path)
    if tex is None:
        return

    tcs = getattr(unreal, "TextureCompressionSettings", None)
    tmgs = getattr(unreal, "TextureMipGenSettings", None)
    tg = getattr(unreal, "TextureGroup", None)

    if kind == "normal":
        _set_prop_any(tex, ("compression_settings",), _enum_attr(tcs, "TC_Normalmap", "TC_NORMALMAP"))
        _set_prop_any(tex, ("srgb",), False)
    elif kind == "orm":
        _set_prop_any(tex, ("compression_settings",), _enum_attr(tcs, "TC_Masks", "TC_MASKS"))
        _set_prop_any(tex, ("srgb",), False)
    elif kind == "linear_scalar":
        _set_prop_any(tex, ("compression_settings",), _enum_attr(tcs, "TC_Grayscale", "TC_GRAYSCALE", "TC_Default", "TC_DEFAULT"))
        _set_prop_any(tex, ("srgb",), False)
    elif kind == "hdri":
        _set_prop_any(tex, ("compression_settings",), _enum_attr(tcs, "TC_HDR"))
        _set_prop_any(tex, ("mip_gen_settings",), _enum_attr(tmgs, "TMGS_NoMipmaps", "TMGS_NO_MIPMAPS"))
        _set_prop_any(tex, ("srgb",), False)
        _set_prop_any(tex, ("lod_group",), _enum_attr(tg, "TEXTUREGROUP_Skybox", "TEXTUREGROUP_SKYBOX"))
    else:
        _set_prop_any(tex, ("compression_settings",), _enum_attr(tcs, "TC_Default", "TC_DEFAULT"))
        _set_prop_any(tex, ("srgb",), True)

    try:
        tex.post_edit_change()
    except Exception:
        pass


def _import_texture_file(
    source_file: str,
    dest_path: str,
    dest_name: str,
    force_reimport: bool = False,
) -> Tuple[bool, str]:
    asset_name = _sanitize_asset_name(dest_name)
    asset_path = f"{dest_path}/{asset_name}"
    if not force_reimport and _asset_exists(asset_path):
        return False, asset_path

    _ensure_directory(dest_path)
    task = unreal.AssetImportTask()
    task.filename = source_file
    task.destination_path = dest_path
    task.destination_name = asset_name
    task.replace_existing = True
    task.automated = True
    task.save = False
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    return True, asset_path


def step_import_kit(repo_root: str, skip_kit: bool, force_reimport: bool) -> Dict[str, int]:
    stats = {"packs": 0, "textures": 0, "hdris": 0, "skipped": 0}
    if skip_kit:
        _log("Step 2/7: Skipping 4K PBR Kit import (OG_SKIP_KIT=1).")
        return stats

    kit_root = os.path.join(repo_root, "ue5", "SourceArt", "Kit")
    if not os.path.isdir(kit_root):
        _warn(
            f"Step 2/7: {kit_root} not found. Run `node tools/assets/masters.mjs fetch` to download the 4K Kit masters."
        )
        return stats

    _log(f"Step 2/7: Importing 4K PBR texture packs & HDRIs from {kit_root} -> {KIT_CONTENT_ROOT}...")

    seen_packs = set()
    for dirpath, _, filenames in sorted(os.walk(kit_root)):
        image_files = sorted(
            f for f in filenames if os.path.splitext(f)[1].lower() in IMAGE_EXTS
        )
        if not image_files:
            continue

        rel_dir = os.path.relpath(dirpath, kit_root).replace("\\", "/")
        parts = [p for p in rel_dir.split("/") if p and p != "."]
        if parts:
            # Map materials/ -> Materials/, hdri/ -> HDRI/ for clean Unreal Content Browser structure
            if parts[0].lower() == "materials":
                parts[0] = "Materials"
            elif parts[0].lower() == "hdri":
                parts[0] = "HDRI"
            seen_packs.add("/".join(parts[:2]))
            dest_path = f"{KIT_CONTENT_ROOT}/{'/'.join(parts)}"
        else:
            dest_path = KIT_CONTENT_ROOT

        for filename in image_files:
            src = os.path.join(dirpath, filename)
            stem = os.path.splitext(filename)[0]
            kind = _classify_kit_texture(filename)
            did_import, asset_path = _import_texture_file(
                source_file=src,
                dest_path=dest_path,
                dest_name=stem,
                force_reimport=force_reimport,
            )
            # Always enforce PBR texture compression/sRGB even if asset already existed (idempotent repair)
            _configure_texture_asset(asset_path, kind)
            if did_import:
                if kind == "hdri":
                    stats["hdris"] += 1
                else:
                    stats["textures"] += 1
            else:
                stats["skipped"] += 1

    stats["packs"] = len(seen_packs)
    _log(
        f"Step 2/7 done: {stats['packs']} packs | imported {stats['textures']} PBR maps, "
        f"{stats['hdris']} HDRIs ({stats['skipped']} already up to date)."
    )
    return stats


# ---------------------------------------------------------------------------
# Step 3: Import Tokyo Night 256x16 Color Grading LUT
# ---------------------------------------------------------------------------

def step_import_lut(repo_root: str, force_reimport: bool) -> Optional[str]:
    lut_src = os.path.join(repo_root, "data", "ue5", "TokyoNight_UE5_256x16.png")
    lut_asset_name = "TokyoNight_UE5_256x16"
    lut_asset_path = f"{POSTPROCESS_CONTENT_ROOT}/{lut_asset_name}"

    if not os.path.isfile(lut_src):
        _warn(
            f"Step 3/7: Missing {lut_src}. Run `python3 tools/ue5/generate_tokyo_night_lut.py` "
            "and re-run this importer to wire the Tokyo Night LUT."
        )
        return lut_asset_path if _asset_exists(lut_asset_path) else None

    _log(f"Step 3/7: Importing Tokyo Night 256x16 LUT -> {lut_asset_path}...")
    did_import, asset_path = _import_texture_file(
        source_file=lut_src,
        dest_path=POSTPROCESS_CONTENT_ROOT,
        dest_name=lut_asset_name,
        force_reimport=force_reimport,
    )

    tex = unreal.EditorAssetLibrary.load_asset(asset_path)
    if tex is not None:
        tcs = getattr(unreal, "TextureCompressionSettings", None)
        tmgs = getattr(unreal, "TextureMipGenSettings", None)
        tg = getattr(unreal, "TextureGroup", None)

        # Exact UE5 Color Grading LUT import settings
        _set_prop_any(tex, ("compression_settings",), _enum_attr(tcs, "TC_HDR"))
        _set_prop_any(
            tex,
            ("lod_group",),
            _enum_attr(tg, "TEXTUREGROUP_ColorLookupTable", "TEXTUREGROUP_COLOR_LOOKUP_TABLE"),
        )
        _set_prop_any(
            tex,
            ("mip_gen_settings",),
            _enum_attr(tmgs, "TMGS_NoMipmaps", "TMGS_NO_MIPMAPS"),
        )
        _set_prop_any(tex, ("srgb",), True)
        _set_prop_any(tex, ("defer_compression",), False)
        try:
            tex.post_edit_change()
        except Exception:
            pass
        _log(
            f"Step 3/7 done: {asset_path} ({'imported' if did_import else 'updated settings'}) "
            "[TC_HDR, TEXTUREGROUP_ColorLookupTable, TMGS_NoMipmaps, sRGB=True]."
        )
    else:
        _warn(f"Step 3/7: Failed to load LUT texture at {asset_path} after import.")
    return asset_path


# ---------------------------------------------------------------------------
# Step 4: Import Car & Parts UDataTable CSVs
# ---------------------------------------------------------------------------

def _find_row_struct(candidate_paths: Iterable[str]) -> Any:
    for path in candidate_paths:
        try:
            obj = unreal.load_object(None, path)
            if obj is not None:
                return obj
        except Exception:
            continue
    return None


def _import_csv_datatable(
    csv_path: str,
    dest_path: str,
    asset_name: str,
    row_struct_candidates: Iterable[str],
    force_reimport: bool = False,
) -> bool:
    if not os.path.isfile(csv_path):
        _warn(
            f"Missing {csv_path}. Run `node tools/ue5/generate_ue5_datatables.mjs` first."
        )
        return False

    target_asset = f"{dest_path}/{asset_name}"
    if not force_reimport and _asset_exists(target_asset):
        _log(f"  DataTable {target_asset} already exists (set OG_FORCE_REIMPORT=1 to reimport).")
        return True

    _ensure_directory(dest_path)
    row_struct = _find_row_struct(row_struct_candidates)

    csv_factory_cls = getattr(unreal, "CSVImportFactory", None)
    if csv_factory_cls is None:
        _warn(f"CSVImportFactory unavailable in this UE build; import {csv_path} manually as DataTable.")
        return False

    if row_struct is None:
        _warn(
            f"No UScriptStruct/UserDefinedStruct found for {asset_name} "
            f"(checked: {', '.join(row_struct_candidates)}). "
            f"Create the matching struct or import {csv_path} via Content Browser -> Import -> DataTable."
        )
        return False

    factory = csv_factory_cls()
    try:
        settings = factory.get_editor_property("automated_import_settings")
        csv_type_cls = getattr(unreal, "CSVImportType", None)
        _set_prop_any(
            settings,
            ("import_type",),
            _enum_attr(csv_type_cls, "ECSV_DATA_TABLE", "ECSV_DataTable"),
        )
        _set_prop_any(settings, ("import_row_struct",), row_struct)
        factory.set_editor_property("automated_import_settings", settings)
    except Exception as exc:
        _warn(f"Could not configure CSVImportFactory for {asset_name}: {exc}")
        return False

    task = unreal.AssetImportTask()
    task.filename = csv_path
    task.destination_path = dest_path
    task.destination_name = asset_name
    task.replace_existing = True
    task.automated = True
    task.save = False
    task.factory = factory

    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    ok = _asset_exists(target_asset)
    _log(f"  DataTable {asset_name} -> {target_asset} ({'imported' if ok else 'check log'})")
    return ok


def step_import_datatables(repo_root: str, force_reimport: bool) -> Dict[str, bool]:
    _log(f"Step 4/7: Importing DataTables into {DATA_CONTENT_ROOT}...")
    data_dir = os.path.join(repo_root, "data", "ue5")
    results = {
        "car_catalog": _import_csv_datatable(
            csv_path=os.path.join(data_dir, "car_catalog_dt.csv"),
            dest_path=DATA_CONTENT_ROOT,
            asset_name="DT_CarCatalog",
            row_struct_candidates=(
                "/Script/OpenGrid.OpenGridCarCatalogRow",
                "/Script/OpenGridPhysics.OpenGridCarCatalogRow",
                f"{DATA_CONTENT_ROOT}/ST_CarCatalogRow.ST_CarCatalogRow",
            ),
            force_reimport=force_reimport,
        ),
        "parts_catalog": _import_csv_datatable(
            csv_path=os.path.join(data_dir, "parts_catalog_dt.csv"),
            dest_path=DATA_CONTENT_ROOT,
            asset_name="DT_PartsCatalog",
            row_struct_candidates=(
                "/Script/OpenGrid.OpenGridPartCatalogRow",
                "/Script/OpenGridPhysics.OpenGridPartCatalogRow",
                f"{DATA_CONTENT_ROOT}/ST_PartCatalogRow.ST_PartCatalogRow",
            ),
            force_reimport=force_reimport,
        ),
    }
    return results


# ---------------------------------------------------------------------------
# Step 5: Spawn / update unbound PPV_TokyoNight APostProcessVolume
# ---------------------------------------------------------------------------

def _vec4(vals: List[float]) -> Any:
    return unreal.Vector4(float(vals[0]), float(vals[1]), float(vals[2]), float(vals[3]))


def _set_pp_override(settings: Any, prop_name: str, value: Any, override_name: Optional[str] = None) -> bool:
    if value is None:
        return False
    ov = override_name or f"override_{prop_name}"
    _set_prop_any(settings, (ov,), True)
    return _set_prop_any(settings, (prop_name,), value)


def _get_or_spawn_ppv(label: str) -> Any:
    actor_sub = None
    try:
        actor_sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception:
        actor_sub = None

    actors = []
    if actor_sub is not None:
        try:
            actors = list(actor_sub.get_all_level_actors())
        except Exception:
            actors = []
    elif hasattr(unreal, "EditorLevelLibrary"):
        try:
            actors = list(unreal.EditorLevelLibrary.get_all_level_actors())
        except Exception:
            actors = []

    ppv_cls = getattr(unreal, "PostProcessVolume", None)
    if ppv_cls is None:
        return None

    for actor in actors:
        if isinstance(actor, ppv_cls) and actor.get_actor_label() == label:
            return actor

    spawn_loc = unreal.Vector(0.0, 0.0, 0.0)
    spawn_rot = unreal.Rotator(0.0, 0.0, 0.0)
    ppv = None
    if actor_sub is not None:
        try:
            ppv = actor_sub.spawn_actor_from_class(ppv_cls, spawn_loc, spawn_rot)
        except Exception:
            ppv = None
    if ppv is None and hasattr(unreal, "EditorLevelLibrary"):
        try:
            ppv = unreal.EditorLevelLibrary.spawn_actor_from_class(ppv_cls, spawn_loc, spawn_rot)
        except Exception:
            ppv = None

    if ppv is not None:
        ppv.set_actor_label(label)
    return ppv


def step_configure_postprocess(repo_root: str, lut_asset_path: Optional[str]) -> bool:
    cfg_path = os.path.join(repo_root, "data", "ue5", "tokyo_night_postprocess.json")
    if not os.path.isfile(cfg_path):
        _warn(
            f"Step 5/7: Missing {cfg_path}. Run `node tools/ue5/generate_ue5_datatables.mjs` first."
        )
        return False

    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    label = cfg.get("name", "PPV_TokyoNight")
    _log(f"Step 5/7: Spawning/updating unbound APostProcessVolume '{label}' from {cfg_path}...")

    ppv = _get_or_spawn_ppv(label)
    if ppv is None:
        _warn(
            "Step 5/7: No editable world loaded (common in commandlet mode without a map argument); "
            "open a level and re-run to spawn PPV_TokyoNight."
        )
        return False

    vol_cfg = cfg.get("volume", {})
    _set_prop_any(ppv, ("unbound", "b_unbound"), bool(vol_cfg.get("bUnbound", True)))
    _set_prop_any(ppv, ("priority",), float(vol_cfg.get("Priority", 10.0)))
    _set_prop_any(ppv, ("blend_weight",), float(vol_cfg.get("BlendWeight", 1.0)))
    _set_prop_any(ppv, ("enabled", "b_enabled"), bool(vol_cfg.get("bEnabled", True)))

    settings = ppv.get_editor_property("settings")

    # Film (ACES Filmic)
    film = cfg.get("film", {})
    _set_pp_override(settings, "film_slope", float(film.get("FilmSlope", 0.91)))
    _set_pp_override(settings, "film_toe", float(film.get("FilmToe", 0.62)))
    _set_pp_override(settings, "film_shoulder", float(film.get("FilmShoulder", 0.28)))
    _set_pp_override(settings, "film_black_clip", float(film.get("FilmBlackClip", 0.0)))
    _set_pp_override(settings, "film_white_clip", float(film.get("FilmWhiteClip", 0.04)))

    # Color Grading: Global, Shadows, Midtones, Highlights
    cg = cfg.get("colorGrading", {})
    glob = cg.get("global", {})
    if "ColorSaturation" in glob:
        _set_pp_override(settings, "color_saturation", _vec4(glob["ColorSaturation"]))
    if "ColorContrast" in glob:
        _set_pp_override(settings, "color_contrast", _vec4(glob["ColorContrast"]))
    if "ColorGamma" in glob:
        _set_pp_override(settings, "color_gamma", _vec4(glob["ColorGamma"]))
    if "ColorGain" in glob:
        _set_pp_override(settings, "color_gain", _vec4(glob["ColorGain"]))
    if "ColorOffset" in glob:
        _set_pp_override(settings, "color_offset", _vec4(glob["ColorOffset"]))

    sh = cg.get("shadows", {})
    if "ColorCorrectionShadowsMax" in sh:
        _set_pp_override(settings, "color_correction_shadows_max", float(sh["ColorCorrectionShadowsMax"]))
    if "ColorSaturationShadows" in sh:
        _set_pp_override(settings, "color_saturation_shadows", _vec4(sh["ColorSaturationShadows"]))
    if "ColorGainShadows" in sh:
        _set_pp_override(settings, "color_gain_shadows", _vec4(sh["ColorGainShadows"]))
    if "ColorOffsetShadows" in sh:
        _set_pp_override(settings, "color_offset_shadows", _vec4(sh["ColorOffsetShadows"]))

    mid = cg.get("midtones", {})
    if "ColorSaturationMidtones" in mid:
        _set_pp_override(settings, "color_saturation_midtones", _vec4(mid["ColorSaturationMidtones"]))
    if "ColorContrastMidtones" in mid:
        _set_pp_override(settings, "color_contrast_midtones", _vec4(mid["ColorContrastMidtones"]))
    if "ColorGammaMidtones" in mid:
        _set_pp_override(settings, "color_gamma_midtones", _vec4(mid["ColorGammaMidtones"]))
    if "ColorGainMidtones" in mid:
        _set_pp_override(settings, "color_gain_midtones", _vec4(mid["ColorGainMidtones"]))

    hi = cg.get("highlights", {})
    if "ColorCorrectionHighlightsMin" in hi:
        _set_pp_override(settings, "color_correction_highlights_min", float(hi["ColorCorrectionHighlightsMin"]))
    if "ColorSaturationHighlights" in hi:
        _set_pp_override(settings, "color_saturation_highlights", _vec4(hi["ColorSaturationHighlights"]))
    if "ColorGainHighlights" in hi:
        _set_pp_override(settings, "color_gain_highlights", _vec4(hi["ColorGainHighlights"]))

    # Color Grading LUT
    target_lut_path = lut_asset_path or cfg.get("LutAssetPath")
    if target_lut_path and _asset_exists(target_lut_path):
        lut_tex = unreal.EditorAssetLibrary.load_asset(target_lut_path)
        if lut_tex is not None:
            _set_pp_override(settings, "color_grading_lut", lut_tex)
            _set_pp_override(
                settings,
                "color_grading_intensity",
                float(cfg.get("ColorGradingIntensity", 1.0)),
            )

    # Bloom (Convolution / FFT)
    bloom = cfg.get("bloom", {})
    bloom_method_cls = getattr(unreal, "BloomMethod", None)
    bm_val = _enum_attr(bloom_method_cls, bloom.get("BloomMethod", "BM_FFT"), "BM_FFT", "BM_SOG")
    if bm_val is not None:
        _set_pp_override(settings, "bloom_method", bm_val)
    _set_pp_override(settings, "bloom_intensity", float(bloom.get("BloomIntensity", 0.68)))
    _set_pp_override(settings, "bloom_threshold", float(bloom.get("BloomThreshold", 1.42)))
    _set_pp_override(settings, "bloom_size_scale", float(bloom.get("BloomSizeScale", 5.2)))
    _set_pp_override(
        settings,
        "bloom_convolution_scatter_dispersion",
        float(bloom.get("BloomConvolutionScatterDispersion", 1.0)),
    )
    _set_pp_override(
        settings,
        "bloom_convolution_pre_filter_min",
        float(bloom.get("BloomConvolutionPreFilterMin", 1.42)),
    )
    _set_pp_override(
        settings,
        "bloom_convolution_pre_filter_max",
        float(bloom.get("BloomConvolutionPreFilterMax", 120.0)),
    )
    _set_pp_override(
        settings,
        "bloom_convolution_pre_filter_mult",
        float(bloom.get("BloomConvolutionPreFilterMult", 12.0)),
    )

    # Reflections & GI (Hardware Ray-Traced Lumen)
    refl = cfg.get("reflections", {})
    refl_method_cls = getattr(unreal, "ReflectionMethod", None)
    gi_method_cls = getattr(unreal, "DynamicGlobalIlluminationMethod", None)
    _set_pp_override(
        settings,
        "reflection_method",
        _enum_attr(refl_method_cls, refl.get("ReflectionMethod", "Lumen"), "LUMEN"),
    )
    _set_pp_override(
        settings,
        "dynamic_global_illumination_method",
        _enum_attr(gi_method_cls, refl.get("DynamicGlobalIlluminationMethod", "Lumen"), "LUMEN"),
    )
    _set_pp_override(settings, "lumen_reflection_quality", float(refl.get("LumenReflectionQuality", 2.0)))
    _set_pp_override(settings, "lumen_scene_lighting_quality", float(refl.get("LumenSceneLightingQuality", 1.5)))
    max_rough = float(refl.get("LumenMaxRoughnessToTraceReflections", 0.45))
    if not _set_pp_override(settings, "lumen_max_roughness_to_trace_reflections", max_rough):
        _set_pp_override(settings, "lumen_reflection_max_roughness", max_rough)

    # Exposure & Lens
    exp = cfg.get("exposure", {})
    aem_cls = getattr(unreal, "AutoExposureMethod", None)
    _set_pp_override(
        settings,
        "auto_exposure_method",
        _enum_attr(aem_cls, exp.get("AutoExposureMethod", "AEM_Histogram"), "AEM_HISTOGRAM"),
    )
    _set_pp_override(settings, "auto_exposure_bias", float(exp.get("AutoExposureBias", 0.15)))
    _set_pp_override(settings, "auto_exposure_min_brightness", float(exp.get("AutoExposureMinBrightness", 0.25)))
    _set_pp_override(settings, "auto_exposure_max_brightness", float(exp.get("AutoExposureMaxBrightness", 1.5)))

    lens = cfg.get("lens", {})
    _set_pp_override(settings, "vignette_intensity", float(lens.get("VignetteIntensity", 0.28)))
    _set_pp_override(settings, "film_grain_intensity", float(lens.get("FilmGrainIntensity", 0.008)))
    _set_pp_override(
        settings,
        "scene_fringe_intensity",
        float(lens.get("ChromaticAberrationIntensity", 0.12)),
    )

    ppv.set_editor_property("settings", settings)
    try:
        ppv.post_edit_change()
    except Exception:
        pass

    _log(f"Step 5/7 done: Configured unbound '{label}' (ACES + Tokyo Night LUT + Convolution Bloom + Lumen Reflections).")
    return True


# ---------------------------------------------------------------------------
# Step 6: Import exported City Landscapes & register PCG spline manifests
# ---------------------------------------------------------------------------

def step_import_cities(
    repo_root: str,
    only_cities: Optional[List[str]],
    force_reimport: bool,
) -> Dict[str, int]:
    stats = {"cities": 0, "maps_imported": 0, "manifests": 0}
    if only_cities is not None and len(only_cities) == 1 and only_cities[0].lower() in {"none", "skip", "0"}:
        _log("Step 6/7: Skipping city Landscape/PCG import (OG_CITY=skip).")
        return stats

    cities_root = os.path.join(repo_root, "ue5", "Import", "Cities")
    if not os.path.isdir(cities_root):
        _log(f"Step 6/7: No exported cities found in {cities_root} (optional).")
        return stats

    city_ids = sorted(
        d for d in os.listdir(cities_root) if os.path.isdir(os.path.join(cities_root, d))
    )
    if only_cities is not None:
        wanted = {c.lower() for c in only_cities}
        city_ids = [c for c in city_ids if c.lower() in wanted]

    if not city_ids:
        _log("Step 6/7: No matching exported cities to process.")
        return stats

    _log(f"Step 6/7: Registering {len(city_ids)} exported city Landscape/PCG package(s)...")

    manifest_out_dir = os.path.join(repo_root, "ue5", "Content", "OpenGridData", "Cities")
    os.makedirs(manifest_out_dir, exist_ok=True)
    registry: Dict[str, Any] = {"schema": "opengrid_ue5_pcg_registry/1", "cities": {}}

    for city_id in city_ids:
        city_dir = os.path.join(cities_root, city_id)
        meta_path = os.path.join(city_dir, "landscape_meta.json")
        if not os.path.isfile(meta_path):
            _warn(f"  [{city_id}] Missing landscape_meta.json in {city_dir}; skipping.")
            continue

        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)

        stats["cities"] += 1
        files = meta.get("files", {})
        res = meta.get("landscape_resolution", {})
        xform = meta.get("ue5_import_transform", {})
        spawn = meta.get("spawn_ue", {})

        height_png = os.path.join(city_dir, files.get("heightmap_png", "landscape_height_16bit.png"))
        height_r16 = os.path.join(city_dir, files.get("heightmap_r16", "landscape_height.r16"))
        roads_json = os.path.join(city_dir, files.get("pcg_roads_json", "pcg_roads.json"))
        roads_csv = os.path.join(city_dir, files.get("pcg_roads_csv", "pcg_roads.csv"))
        route_json = os.path.join(city_dir, files.get("pcg_route_json", "pcg_route.json"))
        landmarks_json = os.path.join(city_dir, files.get("pcg_landmarks_json", "pcg_landmarks.json"))

        # Import weightmaps (8-bit masks) as linear grayscale textures into /Game/OpenGrid/Cities/<city>/Landscape/
        city_landscape_dest = f"{CITIES_CONTENT_ROOT}/{city_id}/Landscape"
        weightmaps_resolved: Dict[str, str] = {}
        for layer_name, fname in sorted(files.get("weightmaps", {}).items()):
            wpath = os.path.join(city_dir, fname)
            if os.path.isfile(wpath):
                weightmaps_resolved[layer_name] = wpath
                did_import, asset_path = _import_texture_file(
                    source_file=wpath,
                    dest_path=city_landscape_dest,
                    dest_name=os.path.splitext(fname)[0],
                    force_reimport=force_reimport,
                )
                _configure_texture_asset(asset_path, "linear_scalar")
                if did_import:
                    stats["maps_imported"] += 1

        # Count spline/landmark records for clear diagnostic logging
        road_count = 0
        landmark_count = 0
        if os.path.isfile(roads_json):
            try:
                with open(roads_json, "r", encoding="utf-8") as rf:
                    rj = json.load(rf)
                road_count = len(rj.get("splines", rj.get("roads", rj if isinstance(rj, list) else [])))
            except Exception:
                pass
        if os.path.isfile(landmarks_json):
            try:
                with open(landmarks_json, "r", encoding="utf-8") as lf:
                    lj = json.load(lf)
                landmark_count = len(lj.get("landmarks", lj if isinstance(lj, list) else []))
            except Exception:
                pass

        city_manifest = {
            "city": city_id,
            "name": meta.get("name", city_id),
            "contentPath": f"{CITIES_CONTENT_ROOT}/{city_id}",
            "landscape": {
                "heightmapPng": height_png,
                "heightmapR16": height_r16,
                "resolution": res,
                "importTransform": xform,
                "weightmaps": weightmaps_resolved,
            },
            "pcg": {
                "roadsJson": roads_json if os.path.isfile(roads_json) else None,
                "roadsCsv": roads_csv if os.path.isfile(roads_csv) else None,
                "routeJson": route_json if os.path.isfile(route_json) else None,
                "landmarksJson": landmarks_json if os.path.isfile(landmarks_json) else None,
                "roadSplineCount": road_count,
                "landmarkCount": landmark_count,
                "spawnUe": spawn,
            },
        }

        city_manifest_path = os.path.join(manifest_out_dir, f"{city_id}_pcg_manifest.json")
        with open(city_manifest_path, "w", encoding="utf-8") as mf:
            json.dump(city_manifest, mf, indent=2)
            mf.write("\n")
        registry["cities"][city_id] = city_manifest_path
        stats["manifests"] += 1

        _log(
            f"  [{city_id}] Landscape heightmap: {height_r16} ({res.get('width')}x{res.get('height')}, "
            f"{res.get('components_x')}x{res.get('components_y')} comps) | "
            f"Scale=({xform.get('ScaleX_cm')}, {xform.get('ScaleY_cm')}, {xform.get('ScaleZ_cm')}) cm | "
            f"Loc=({xform.get('LocationX_cm')}, {xform.get('LocationY_cm')}, {xform.get('LocationZ_cm')}) cm"
        )
        _log(
            f"  [{city_id}] Weightmaps ({len(weightmaps_resolved)}): {', '.join(sorted(weightmaps_resolved.keys()))} | "
            f"PCG splines: {roads_json} ({road_count}) | Route: {route_json} | Landmarks: {landmarks_json} ({landmark_count})"
        )
        _log(f"  [{city_id}] Registered PCG manifest -> {city_manifest_path}")

    registry_path = os.path.join(manifest_out_dir, "pcg_registry.json")
    with open(registry_path, "w", encoding="utf-8") as rf:
        json.dump(registry, rf, indent=2)
        rf.write("\n")

    _log(
        f"Step 6/7 done: {stats['cities']} cities registered, {stats['maps_imported']} weightmaps imported, "
        f"PCG registry -> {registry_path}."
    )
    return stats


# ---------------------------------------------------------------------------
# Step 7: Save all newly imported packages cleanly
# ---------------------------------------------------------------------------

def step_save_all(save_level: bool) -> None:
    _log(f"Step 7/7: Saving dirty packages under {CONTENT_ROOT}...")
    try:
        unreal.EditorAssetLibrary.save_directory(
            CONTENT_ROOT,
            only_if_is_dirty=True,
            recursive=True,
        )
    except Exception as exc:
        _warn(f"save_directory({CONTENT_ROOT}) reported an issue: {exc}")

    if save_level:
        try:
            level_sub = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
            if level_sub is not None:
                level_sub.save_current_level()
        except Exception:
            try:
                if hasattr(unreal, "EditorLevelLibrary"):
                    unreal.EditorLevelLibrary.save_current_level()
            except Exception:
                pass

    _log("Step 7/7 done: All packages saved.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    t0 = time.time()
    repo_root = _resolve_repo_root()

    only_cars = _env_list("OG_ONLY_CAR")
    only_cities = _env_list("OG_CITY")
    skip_kit = _env_flag("OG_SKIP_KIT", default=False)
    use_nanite = _env_flag("OG_USE_NANITE", default=False)
    force_reimport = _env_flag("OG_FORCE_REIMPORT", default=False)

    _log("=" * 76)
    _log("OpenGrid UE 5.8 One-Click Auto-Importer starting")
    _log(f"  Repo root:         {repo_root}")
    _log(f"  OG_ONLY_CAR:       {only_cars or 'ALL (24 cars)'}")
    _log(f"  OG_CITY:           {only_cities or 'ALL exported cities'}")
    _log(f"  OG_SKIP_KIT:       {skip_kit}")
    _log(f"  OG_USE_NANITE:     {use_nanite}")
    _log(f"  OG_FORCE_REIMPORT: {force_reimport}")
    _log("=" * 76)

    car_stats = step_import_cars(repo_root, only_cars, use_nanite, force_reimport)
    kit_stats = step_import_kit(repo_root, skip_kit, force_reimport)
    lut_asset_path = step_import_lut(repo_root, force_reimport)
    dt_stats = step_import_datatables(repo_root, force_reimport)
    ppv_ok = step_configure_postprocess(repo_root, lut_asset_path)
    city_stats = step_import_cities(repo_root, only_cities, force_reimport)
    step_save_all(save_level=ppv_ok)

    elapsed = time.time() - t0
    _log("=" * 76)
    _log(
        f"OpenGrid UE 5.8 Auto-Import complete in {elapsed:.1f}s | "
        f"Cars={car_stats['cars']} (bodies={car_stats['bodies']}, parts={car_stats['parts']}) | "
        f"Kit={kit_stats['packs']} packs ({kit_stats['textures']} PBR + {kit_stats['hdris']} HDRI) | "
        f"LUT={'OK' if lut_asset_path else 'MISSING'} | "
        f"DataTables={sum(1 for v in dt_stats.values() if v)}/2 | "
        f"PPV_TokyoNight={'OK' if ppv_ok else 'DEFERRED'} | "
        f"Cities={city_stats['cities']}"
    )
    _log("=" * 76)


if __name__ == "__main__":
    main()
