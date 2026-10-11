"""Read-only Python project inspection. Never imports or runs project code.

Protocol: one UTF-8 JSON request on stdin, one JSON result on stdout.
Run with Python 3.11+ and -I -S to avoid workspace paths and site hooks.
"""
import ast
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import tokenize
import tomllib

EXCLUDED = {".venv", "venv", "env", ".git", ".hg", ".svn", "node_modules",
            "__pycache__", ".tox", ".nox", "build", "dist", ".mypy_cache",
            ".pytest_cache", ".ruff_cache", ".test-work", ".eggs", "site-packages"}


def normalize(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def load_toml(path, warnings):
    if not path.exists():
        return {}
    try:
        with path.open("rb") as stream:
            return tomllib.load(stream)
    except (OSError, tomllib.TOMLDecodeError) as error:
        warnings.append(f"{path.name}: {error}")
        return {}


def read_manifest(root, warnings):
    data = load_toml(root / "pyproject.toml", warnings)
    project = data.get("project", {})
    declared = {}

    def add(requirements, scope):
        for requirement in requirements:
            if not isinstance(requirement, str):
                continue
            match = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)", requirement)
            if match:
                name = normalize(match.group(1))
                row = declared.setdefault(name, {"name": name, "requirements": [], "scopes": [], "conditional": False})
                row["requirements"].append(requirement)
                if scope not in row["scopes"]:
                    row["scopes"].append(scope)
                row["conditional"] |= ";" in requirement

    add(project.get("dependencies", []), "runtime")
    for extra, requirements in project.get("optional-dependencies", {}).items():
        add(requirements, "extra:" + extra)
    groups = data.get("dependency-groups", {})

    def group_requirements(name, visited):
        if name in visited:
            return []
        result = []
        for item in groups.get(name, []):
            if isinstance(item, str):
                result.append(item)
            elif isinstance(item, dict) and "include-group" in item:
                result.extend(group_requirements(item["include-group"], visited | {name}))
        return result

    for group in groups:
        add(group_requirements(group, set()), "group:" + group)
    add(data.get("tool", {}).get("uv", {}).get("dev-dependencies", []), "group:dev")
    blockers = []
    if "dependencies" in project.get("dynamic", []):
        warnings.append("项目使用动态依赖；静态扫描无法读取全部声明。")
        blockers.append("动态依赖需要构建项目元数据，当前预览不支持。")
    uv_config = data.get("tool", {}).get("uv", {})
    if any(not isinstance(source, dict) or set(source) - {"index", "marker", "extra", "group"}
           for source in uv_config.get("sources", {}).values()):
        blockers.append("项目包含本地、Git 或直接 URL 源；无法在隔离副本中可靠预览，请使用 uv 管理。")
    if uv_config.get("find-links"):
        blockers.append("项目使用 find-links，当前隔离预览不支持相对文件源。")
    for row in declared.values():
        if any(" @ " in requirement for requirement in row["requirements"]):
            blockers.append("项目包含直接引用依赖，当前隔离预览不支持。")
            break
    if data.get("tool", {}).get("poetry") and not project:
        warnings.append("检测到 Poetry 专用配置；此版本读取 PEP 621 [project]，请先迁移后使用 uv 操作。")
    if data.get("tool", {}).get("uv", {}).get("workspace"):
        warnings.append("检测到 uv workspace；目前只读扫描，环境操作请使用独立项目。")
    workspace_root = None
    for ancestor in root.parents:
        manifest = ancestor / "pyproject.toml"
        try:
            if manifest.is_file():
                with manifest.open("rb") as stream:
                    parent_data = tomllib.load(stream)
                if parent_data.get("tool", {}).get("uv", {}).get("workspace"):
                    workspace_root = str(ancestor)
                    warnings.append("上级目录存在 uv workspace；目前只读扫描，避免修改上级锁文件。")
                    break
        except (OSError, tomllib.TOMLDecodeError):
            continue
    if not (root / "pyproject.toml").exists() and (root / "requirements.txt").exists():
        warnings.append("检测到 requirements.txt；可在面板预览导入，确认后建立 pyproject.toml。")
    lock = load_toml(root / "uv.lock", warnings)
    locked = {}
    for package in lock.get("package", []):
        name, version = package.get("name"), package.get("version")
        if name and version:
            versions = locked.setdefault(normalize(name), [])
            if version not in versions:
                versions.append(version)
    return {
        "exists": (root / "pyproject.toml").exists(),
        "name": project.get("name", root.name),
        "requiresPython": project.get("requires-python"),
        "declared": list(declared.values()), "locked": locked,
        "lockExists": (root / "uv.lock").exists(),
        "hasProjectTable": bool(project),
        "uvWorkspace": bool(data.get("tool", {}).get("uv", {}).get("workspace")),
        "uvWorkspaceRoot": workspace_root,
        "groups": sorted(set(groups) | ({"dev"} if uv_config.get("dev-dependencies") else set())),
        "extras": sorted(project.get("optional-dependencies", {})),
        "previewBlockers": blockers,
        "lockPackages": [{key: package[key] for key in ("name", "version", "source", "wheels") if key in package}
                         for package in lock.get("package", [])]
    }


def read_requirements(root):
    file = root / "requirements.txt"
    result = {"exists": file.is_file(), "entries": [], "unsupported": []}
    if not result["exists"]:
        return result
    if file.stat().st_size > 1024 * 1024:
        result["unsupported"].append({"line": 1, "text": "", "reason": "文件超过 1 MB"})
        return result
    try:
        text = file.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as error:
        result["unsupported"].append({"line": 1, "text": "", "reason": "无法按 UTF-8 读取：" + str(error)})
        return result
    pending = ""
    start_line = 1
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not pending:
            start_line = number
        if line.endswith("\\"):
            pending += line[:-1] + " "
            continue
        line = pending + line
        pending = ""
        line = re.split(r"\s+#", line, maxsplit=1)[0].strip()
        if not line or line.startswith("#"):
            continue
        # uv parses the complete PEP 508 requirement. Do not interpret directives,
        # local paths or URL references, and never silently import a partial file.
        if (not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[|\s*[<>=!~;]|\s*$)", line)
                or "@" in line or "--" in line or "://" in line or "/" in line or "\\" in line):
            result["unsupported"].append({"line": start_line, "text": line,
                                          "reason": "仅支持普通包名、extras、版本约束和环境标记；不支持 -r/-c、URL、路径、hash 或包源指令"})
        elif line not in result["entries"]:
            result["entries"].append(line)
    if pending:
        result["unsupported"].append({"line": start_line, "text": pending, "reason": "未结束的续行"})
    return result


def contains_python(directory, excluded):
    # A namespace package may not have __init__.py. Only search a bounded depth.
    for base, dirs, files in os.walk(directory, followlinks=False):
        depth = len(Path(base).relative_to(directory).parts)
        dirs[:] = [name for name in dirs if name not in excluded and not name.startswith(".")
                   and not (Path(base) / name).is_symlink()] if depth < 4 else []
        if any(name.endswith(".py") for name in files):
            return True
    return False


def local_names(directory, excluded):
    names = set()
    try:
        for entry in directory.iterdir():
            if entry.name in excluded or entry.name.startswith(".") or entry.is_symlink():
                continue
            if entry.is_file() and entry.suffix == ".py":
                names.add(entry.stem)
            elif entry.is_dir() and entry.name.isidentifier() and contains_python(entry, excluded):
                names.add(entry.name)
    except OSError:
        pass
    return names


def scan(root, stdlib, max_files, excluded):
    imports, filtered, errors = {}, {"stdlib": set(), "local": set(), "relative": set()}, []
    global_local = local_names(root, excluded) | local_names(root / "src", excluded)
    local_cache = {}
    count, truncated = 0, False
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(name for name in dirs if name not in excluded and not name.startswith(".")
                         and not (Path(base) / name).is_symlink())
        for name in sorted(files):
            path = Path(base) / name
            if path.suffix != ".py" or path.is_symlink():
                continue
            if count >= max_files:
                truncated = True
                break
            count += 1
            relative = path.relative_to(root).as_posix()
            try:
                if path.stat().st_size > 2 * 1024 * 1024:
                    errors.append({"file": relative, "line": 1, "message": "文件超过 2 MB，已跳过。"})
                    continue
                with tokenize.open(path) as stream:
                    tree = ast.parse(stream.read(), filename=relative)
            except (SyntaxError, OSError, UnicodeError, ValueError) as error:
                errors.append({"file": relative, "line": getattr(error, "lineno", 1) or 1, "message": str(error)})
                continue
            if base not in local_cache:
                local_cache[base] = global_local | local_names(Path(base), excluded)
            for node in ast.walk(tree):
                modules = []
                if isinstance(node, ast.Import):
                    modules = [alias.name.split(".")[0] for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    if node.level:
                        filtered["relative"].add(node.module or ".")
                        continue
                    if node.module:
                        modules = [node.module.split(".")[0]]
                for module in modules:
                    if module in stdlib:
                        filtered["stdlib"].add(module)
                    elif module in local_cache[base]:
                        filtered["local"].add(module)
                    else:
                        imports.setdefault(module, []).append({"file": relative, "line": node.lineno, "column": node.col_offset})
        if truncated:
            break
    return {"imports": [{"module": name, "locations": locations} for name, locations in sorted(imports.items())],
            "filtered": {key: sorted(value) for key, value in filtered.items()}, "errors": errors,
            "fileCount": count, "truncated": truncated}


def installed(root, warnings):
    venv = root / ".venv"
    paths = [venv / "Lib" / "site-packages"]
    paths.extend(venv.glob("lib/python*/site-packages"))
    result = []
    try:
        for dist in importlib.metadata.distributions(path=[str(path) for path in paths if path.exists()]):
            name = dist.metadata.get("Name")
            if not name:
                continue
            top_level = dist.read_text("top_level.txt") or ""
            modules = {line.strip() for line in top_level.splitlines() if line.strip().isidentifier()}
            # RECORD is metadata, reading it never imports the distribution.
            for record in dist.files or []:
                parts = Path(str(record).replace("/", os.sep)).parts
                if not parts or parts[0] in {"..", "__pycache__"}:
                    continue
                first = parts[0]
                candidate = first.split(".")[0] if len(parts) == 1 else first
                if candidate.isidentifier() and ".dist-info" not in first and ".data" not in first:
                    if len(parts) > 1 or first.endswith((".py", ".pyd", ".so")):
                        modules.add(candidate)
            result.append({"name": normalize(name), "version": dist.version, "modules": sorted(modules)})
    except (OSError, ValueError) as error:
        warnings.append("无法完整读取环境安装信息：" + str(error))
    return sorted(result, key=lambda row: row["name"])


def cache_info(cache_dir, names):
    """Best-effort artifact presence, not proof that uv can reuse a wheel.

    uv cache layout is not a public stable API. Restrict the walk to package
    directories under wheels-v*/index. Do not follow archive symlinks.
    """
    result = {normalize(name): {"present": False, "versions": []} for name in names}
    root = Path(cache_dir)
    if not root.is_dir():
        return {"packages": result, "supported": False}
    indexes = []
    for bucket in root.glob("wheels-v*"):
        index = bucket / "index"
        if index.is_dir():
            indexes.extend(child for child in index.iterdir() if child.is_dir())
    for index in indexes:
        for name, row in result.items():
            directory = index / name.replace("-", "_")
            if not directory.is_dir():
                directory = index / name
            if directory.is_dir():
                # Require an actual wheel reference, not just an empty package folder.
                refs = list(directory.glob("*/*.msgpack")) + list(directory.glob("*/*.whl"))
                # Newer uv uses extensionless wheel reference files + .http sidecars.
                refs += [entry for entry in directory.iterdir() if entry.is_file()
                         and re.match(r"^\d.*-(?:py|cp|pp)\d.*-.*-.*$", entry.name)
                         and not entry.name.endswith((".http", ".lock"))]
                if refs:
                    row["present"] = True
                    row["versions"] = sorted({ref.name.split("-")[0] if ref.parent == directory else ref.parent.name for ref in refs})
    return {"packages": result, "supported": bool(indexes)}


def main():
    request = json.load(sys.stdin)
    if request.get("mode") == "cache":
        result = cache_info(request["cacheDir"], request.get("names", []))
    else:
        root = Path(request["root"]).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("项目路径必须是目录")
        warnings = []
        stdlib = set(request.get("stdlib") or sys.stdlib_module_names) | set(sys.builtin_module_names)
        result = {"manifest": read_manifest(root, warnings), "installed": installed(root, warnings),
                  "requirements": read_requirements(root), "warnings": warnings}
        if request.get("mode") != "metadata":
            result["scan"] = scan(root, stdlib, int(request.get("maxFiles", 4000)), EXCLUDED | set(request.get("exclude", [])))
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
