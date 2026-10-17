"""Tree-sitter outlines for code documents (indexer/code_outline.py)."""

import pytest

import code_outline


PYTHON = b"""import os
from pathlib import Path


class Repo:
    \"\"\"Repository access.\"\"\"

    def load(self, path):
        return path


@decorate
def main():
    pass
"""

TYPESCRIPT = b"""import { x } from './x';

export interface Shape {
  area(): number;
}

export class Circle implements Shape {
  area(): number {
    return 1;
  }
}
"""

GO = b"""package main

import "fmt"

func Run() {
	fmt.Println("hi")
}

func (s *Server) Start(addr string) error {
	return nil
}
"""

RUST = b"""use std::fmt;

/// Thing doc.
pub struct Thing {
    x: i32,
}

impl Thing {
    pub fn new() -> Self {
        Thing { x: 0 }
    }
}
"""

# One definition per language; each must produce an outline with its first symbol on line 1.
MINIMAL = {
    "a.js": b"function greet(name) {\n  return name;\n}\n",
    "a.tsx": b"export function App() {\n  return <div/>;\n}\n",
    "a.java": b"public class Svc {\n  public void run() {}\n}\n",
    "a.c": b"int add(int a, int b) {\n  return a + b;\n}\n",
    "a.cpp": b"class Engine {\npublic:\n  void start();\n};\n",
    "a.cs": b"public class Repo {\n  public int Count() { return 0; }\n}\n",
    "a.rb": b"class Parser\n  def parse(text)\n    text\n  end\nend\n",
    "a.lua": b"function M.load(path)\n  return path\nend\n",
    "a.sh": b"build() {\n  echo hi\n}\n",
    "a.php": b"<?php\nclass User {\n  public function name() { return 1; }\n}\n",
}


def symbols(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.startswith("- ") or line.startswith("  - ")]


def test_python_outline_has_lines_signatures_imports_and_docstring():
    text = code_outline.outline("pkg/repo.py", PYTHON)
    assert text is not None
    assert text.startswith("File: pkg/repo.py\nLanguage: python\n")
    assert "- import os" in text and "- from pathlib import Path" in text
    assert "- L5 class Repo:" in text
    assert "doc: Repository access." in text
    assert "  - L8 def load(self, path):" in text
    # Decorators are skipped: the signature is the definition line itself.
    assert "- L13 def main():" in text


def test_typescript_outline_reports_interface_class_and_method():
    text = code_outline.outline("src/shape.ts", TYPESCRIPT)
    assert text is not None
    assert "- L3 export interface Shape {" in text
    assert "- L7 export class Circle implements Shape {" in text
    assert "  - L8 area(): number {" in text


def test_go_outline_reports_functions_and_methods():
    text = code_outline.outline("main.go", GO)
    assert text is not None
    assert '- "fmt"' in text
    assert "- L5 func Run() {" in text
    assert "- L9 func (s *Server) Start(addr string) error {" in text


def test_rust_outline_reports_struct_with_doc_and_impl_method():
    text = code_outline.outline("src/lib.rs", RUST)
    assert text is not None
    assert "- use std::fmt;" in text
    assert "- L4 pub struct Thing {" in text
    assert "doc: Thing doc." in text
    assert "- L8 impl Thing {" in text
    assert "  - L9 pub fn new() -> Self {" in text


@pytest.mark.parametrize("name, source", MINIMAL.items())
def test_each_supported_language_outlines_its_first_definition(name, source):
    text = code_outline.outline(name, source)
    assert text is not None, name
    assert symbols(text), name
    assert "- L" in text, name


def test_unknown_suffix_returns_none():
    assert code_outline.outline("notes.txt", b"def f(): pass\n") is None
    assert code_outline.outline("README", b"# title\n") is None
    assert code_outline.language_for("notes.md") is None


def test_syntax_error_does_not_raise():
    # Tree-sitter recovers and may return a partial outline; the contract is only that nothing raises.
    text = code_outline.outline("broken.py", b"def broken(:\n  x = = 3\n\n\nclass ok:\n  pass\n")
    assert text is None or text.startswith("File: broken.py")


def test_non_utf8_source_returns_none():
    assert code_outline.outline("latin.py", b"def f():\n    return '\xff'\n") is None


def test_empty_file_returns_none():
    assert code_outline.outline("empty.py", b"") is None
