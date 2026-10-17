"""Compact symbol outlines for source files, parsed in-process with tree-sitter (tree-sitter-language-pack)."""

import os
import re
from pathlib import Path

from tree_sitter_language_pack import PackConfig, ProcessConfig, get_parser, init, process


SIGNATURE_LIMIT = 160
DOC_LIMIT = 120
MAX_OUTLINE_LINES = 150
MAX_IMPORTS = 60
GRAMMAR_DIR_ENV = "TREE_SITTER_GRAMMAR_DIR"
LANGUAGE_BY_SUFFIX = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".lua": "lua",
    ".sh": "bash",
    ".php": "php",
}
# The pack's structure extraction does not report imports for these grammars; match their import lines instead.
FALLBACK_IMPORTS = {
    "c": re.compile(r"^\s*#\s*include\b"),
    "cpp": re.compile(r"^\s*#\s*include\b"),
    "csharp": re.compile(r"^\s*using\s+[\w.]+\s*;"),
    "ruby": re.compile(r"^\s*require(_relative)?\b"),
    "lua": re.compile(r"^\s*(local\s+[\w, ]+=\s*)?require\b"),
    "php": re.compile(r"^\s*use\s+[\w\\ ,{}]+;"),
}
# Decorators and attributes sit above the definition; the signature is the first line after them.
ATTRIBUTE_PREFIXES = ("@", "#[", "[")
DOC_QUOTES = ('"""', "'''")
COMMENT_MARKERS = re.compile(r"^\s*(///<|///|//!|//|/\*\*|/\*!|/\*|\*|#|--)\s*")

_ready = False


def language_for(path: str) -> str | None:
    return LANGUAGE_BY_SUFFIX.get(Path(path).suffix.lower())


def _load(language: str) -> None:
    """Load the grammar. Raises when it is missing, so a broken image fails the sync instead of emptying code docs."""
    global _ready
    if not _ready:
        init(PackConfig(cache_dir=os.environ.get(GRAMMAR_DIR_ENV) or None))
        _ready = True
    get_parser(language)


def _clip(text: str, limit: int = SIGNATURE_LIMIT) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _one_line(text: str) -> str:
    return " ".join(text.split())


def _signature(item, lines: list[str]) -> str:
    for row in range(item.span.start_line, min(item.span.end_line, len(lines) - 1) + 1):
        text = lines[row].strip()
        if text and not text.startswith(ATTRIBUTE_PREFIXES):
            return _clip(text)
    return _clip(f"{item.kind} {item.name or ''}".strip())


def _doc(item, lines: list[str], language: str) -> str:
    if language == "python" and item.body_span is not None:
        # Python docstrings are the first statement of the body; the pack does not extract them.
        for row in range(item.body_span.start_line, min(item.body_span.start_line + 2, len(lines))):
            text = lines[row].strip()
            if not text.startswith(DOC_QUOTES):
                return ""
            cleaned = text[3:].rstrip("\"'").strip()
            if cleaned:
                return _clip(cleaned, DOC_LIMIT)
        return ""
    for raw in (item.doc_comment or "").splitlines():
        cleaned = COMMENT_MARKERS.sub("", raw).strip().rstrip("*/").strip()
        if cleaned:
            return _clip(cleaned, DOC_LIMIT)
    return ""


def _imports(result, language: str, lines: list[str]) -> list[str]:
    found = [_clip(_one_line(item.source)) for item in result.imports]
    if not found and language in FALLBACK_IMPORTS:
        found = [_clip(_one_line(line)) for line in lines if FALLBACK_IMPORTS[language].match(line)]
    return list(dict.fromkeys(item for item in found if item))[:MAX_IMPORTS]


def _symbol_lines(items, lines: list[str], language: str, depth: int, out: list[str], rows: set[int]) -> None:
    indent = "  " * depth
    for item in items:
        if len(out) >= MAX_OUTLINE_LINES:
            return
        # A one-line member shares its parent's line; listing that line twice adds nothing.
        if item.span.start_line not in rows:
            rows.add(item.span.start_line)
            out.append(f"{indent}- L{item.span.start_line + 1} {_signature(item, lines)}")
            doc = _doc(item, lines, language)
            if doc:
                out.append(f"{indent}  doc: {doc}")
        _symbol_lines(item.children, lines, language, depth + 1, out, rows)


def outline(path: str, data: bytes) -> str | None:
    """Return a text outline of one source file, or None when the suffix is unsupported or the file does not parse."""
    language = language_for(path)
    if language is None:
        return None
    try:
        source = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    _load(language)
    try:
        result = process(source, ProcessConfig(language=language, structure=True, imports=True, exports=False))
    except Exception:
        return None
    lines = source.split("\n")
    imports = _imports(result, language, lines)
    symbols: list[str] = []
    _symbol_lines(result.structure, lines, language, 0, symbols, set())
    if not symbols and not imports:
        return None
    body = [f"File: {path}", f"Language: {language}"]
    if imports:
        body += ["Imports:"] + [f"- {item}" for item in imports]
    if symbols:
        body += ["Symbols:"] + symbols
    return "\n".join(body)
