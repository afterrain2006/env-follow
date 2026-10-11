import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("inspector", Path(__file__).parents[1] / "python" / "inspect_project.py")
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)


class InspectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, file, text):
        path = self.root / file
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def scan(self, maximum=4000):
        return inspector.scan(self.root, set(sys.stdlib_module_names), maximum, inspector.EXCLUDED)

    def test_ast_filters_and_never_executes_code(self):
        self.write("main.py", '''import os, sys
import numpy as np
from PIL.Image import open
from local_pkg import thing
from src_pkg import thing
from . import neighbor
"import fake_in_string"
# import fake_in_comment
raise RuntimeError("must never run")
''')
        self.write("local_pkg/__init__.py", "")
        self.write("src/src_pkg/__init__.py", "")
        self.write(".venv/ignored.py", "import excluded")
        result = self.scan()
        self.assertEqual([item["module"] for item in result["imports"]], ["PIL", "numpy"])
        self.assertEqual(result["filtered"]["local"], ["local_pkg", "src_pkg"])
        self.assertEqual(result["fileCount"], 3)
        self.assertFalse(result["errors"])

    def test_nested_local_module_does_not_hide_global_import_elsewhere(self):
        self.write("main.py", "import requests\n")
        self.write("tools/script.py", "import requests\n")
        self.write("tools/requests.py", "")
        result = self.scan()
        self.assertEqual(result["imports"][0]["locations"][0]["file"], "main.py")
        self.assertEqual(len(result["imports"][0]["locations"]), 1)

    def test_namespace_package_and_multiline_imports(self):
        self.write("src/my_namespace/part/api.py", "")
        self.write("main.py", "from my_namespace.part import api\nfrom sklearn.model_selection import (\n train_test_split,\n)\n")
        result = self.scan()
        self.assertEqual(result["imports"][0]["module"], "sklearn")
        self.assertIn("my_namespace", result["filtered"]["local"])

    def test_syntax_error_is_reported_and_other_files_continue(self):
        self.write("broken.py", "import (")
        self.write("valid.py", "import numpy\n")
        result = self.scan()
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(result["imports"][0]["module"], "numpy")

    def test_file_limit_is_explicit(self):
        for index in range(3):
            self.write(f"file{index}.py", "import numpy")
        result = self.scan(2)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["fileCount"], 2)

    def test_manifest_groups_conditions_and_lock_versions(self):
        self.write("pyproject.toml", '''[project]
name = "sample"
requires-python = ">=3.11"
dependencies = ["Pillow>=10", "requests[socks]>=2; sys_platform == 'win32'"]
[project.optional-dependencies]
data = ["pandas"]
[dependency-groups]
dev = ["pytest"]
test = [{include-group = "dev"}, "httpx"]
''')
        self.write("uv.lock", 'version = 1\n[[package]]\nname = "pillow"\nversion = "10.4.0"\n')
        warnings = []
        result = inspector.read_manifest(self.root, warnings)
        rows = {item["name"]: item for item in result["declared"]}
        self.assertEqual(rows["pillow"]["scopes"], ["runtime"])
        self.assertTrue(rows["requests"]["conditional"])
        self.assertEqual(rows["pytest"]["scopes"], ["group:dev", "group:test"])
        self.assertEqual(result["locked"]["pillow"], ["10.4.0"])
        self.assertFalse(warnings)

    def test_corrupt_toml_reports_real_error(self):
        self.write("pyproject.toml", "[project\n")
        warnings = []
        inspector.read_manifest(self.root, warnings)
        self.assertIn("pyproject.toml:", warnings[0])

    def test_installed_metadata_is_read_without_importing_package(self):
        self.write(".venv/Lib/site-packages/demo-1.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: demo\nVersion: 1.0\n")
        self.write(".venv/Lib/site-packages/demo-1.0.dist-info/RECORD", "actual_module/__init__.py,,\ndemo-1.0.dist-info/METADATA,,\n")
        self.write(".venv/Lib/site-packages/actual_module/__init__.py", "raise RuntimeError('must never run')")
        result = inspector.installed(self.root, [])
        self.assertEqual(result[0]["modules"], ["actual_module"])
        self.assertEqual(result[0]["version"], "1.0")

    def test_requirements_constraints_markers_and_unsupported_directives(self):
        self.write("requirements.txt", "# demo\nrequests>=2.32,<3\ncolorama; sys_platform == 'win32'\n-r private.txt\n")
        result = inspector.read_requirements(self.root)
        self.assertEqual(result["entries"], ["requests>=2.32,<3", "colorama; sys_platform == 'win32'"])
        self.assertEqual(result["unsupported"][0]["line"], 4)

    def test_local_sources_are_explicit_preview_blockers(self):
        self.write("pyproject.toml", '[project]\nname = "demo"\ndependencies = ["local"]\n[tool.uv.sources]\nlocal = {path = "../local"}\n')
        self.assertTrue(inspector.read_manifest(self.root, [])["previewBlockers"])

    def test_cache_presence_requires_artifact_not_empty_directory(self):
        self.write("cache/wheels-v6/index/pypi/pillow/10.0-py3-none-any", "ref")
        (self.root / "cache/wheels-v6/index/pypi/numpy").mkdir(parents=True)
        result = inspector.cache_info(self.root / "cache", ["Pillow", "numpy"])
        self.assertTrue(result["packages"]["pillow"]["present"])
        self.assertEqual(result["packages"]["pillow"]["versions"], ["10.0"])
        self.assertFalse(result["packages"]["numpy"]["present"])


if __name__ == "__main__":
    unittest.main()
