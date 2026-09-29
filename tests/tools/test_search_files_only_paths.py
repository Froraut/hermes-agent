"""files_only search returns every matching path, including paths with spaces.

Regression: the stdout/stderr shape filter treated a files_only line with whitespace
("My Project/app.py", "Application Support", "Google Drive") as diagnostic prose and dropped it,
while content and count modes returned the same file.
"""

import pytest

from tools.environments.local import LocalEnvironment
from tools.file_operations import ShellFileOperations


@pytest.mark.parametrize("native", ["0", "1"], ids=["shell", "native"])
def test_files_only_keeps_paths_with_spaces(tmp_path, monkeypatch, native):
    monkeypatch.setenv("HERMES_NATIVE_FILE_READ", native)
    spaced = tmp_path / "My Project" / "app.py"
    spaced.parent.mkdir()
    spaced.write_text("# TODO: ship\n", encoding="utf-8")
    (tmp_path / "plain.py").write_text("# TODO: test\n", encoding="utf-8")
    ops = ShellFileOperations(LocalEnvironment(cwd=str(tmp_path)), cwd=str(tmp_path))

    # Relative root: the tmp prefix ("pytest-0") contains a ``-<digit>`` that happens to satisfy
    # the content-line shape and would mask the bug for absolute paths.
    files = ops.search("TODO", path=".", output_mode="files_only")
    content = ops.search("TODO", path=".")

    assert not files.error, files.error
    assert sorted(files.files) == sorted({m.path for m in content.matches}), files.to_dict()
    assert any("My Project" in f for f in files.files)
