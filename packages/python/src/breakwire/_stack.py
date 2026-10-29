"""Local stack normalization (same rules as the JS client; shared fixtures: tests/stack-cases.json).

package.json, lockfiles, requirements, pyproject, runtime files and workflow YAML are parsed in this process; only
dependency and runtime facts (names, versions, runtimes, action refs) are sent. Scripts, repository URLs, private
registry URLs, git/file/workspace dependencies, comments and everything else stay home.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Set, Tuple

MAX_PACKAGES = 500
_NON_REGISTRY_SPEC = re.compile(r"^(?:file|link|git|git\+[a-z]+|github|gitlab|bitbucket|https?|workspace|portal|patch|exec):|://|^[\w.-]+/[\w.-]+(?:#.*)?$|^[.~/]", re.I)
_RAW_KEYS = {"files", "package_json", "requirements_txt", "pyproject_toml", "requirements", "workflows", "nvmrc", "netlify_toml", "vercel_json"}
_DEP_KEYS = ("dependencies", "devDependencies", "peerDependencies")
STACK_FIELDS = _RAW_KEYS | set(_DEP_KEYS) | {"engines", "packages", "runtime", "services", "ecosystem"}
_REQ = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*((?:===|==|!=|~=|>=|<=|>|<)\s*[^\s,;]+(?:\s*,\s*(?:===|==|!=|~=|>=|<=|>|<)\s*[^\s,;]+)*)?\s*$")


def _base(p: str) -> str:
    return p.replace("\\", "/").split("/")[-1] or p


def _pep503(n: str) -> str:
    return re.sub(r"[-_.]+", "-", n.lower())


def _clean_deps(d: Any) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not isinstance(d, dict):
        return out
    for k, v in d.items():
        if not isinstance(v, str) or not re.match(r"^(@[\w.-]+/)?[\w.-]+$", str(k)):
            continue
        spec = v.strip()
        if _NON_REGISTRY_SPEC.search(spec):
            continue
        out[k] = spec[:64]
    return out


def normalize_requirement(line: str) -> Optional[str]:
    """One requirements line -> "name<spec>" (PEP 503 name; no extras, markers, hashes, URLs or options), or None."""
    s = re.sub(r"(^|\s)#.*$", "", str(line)).strip()
    if not s or s.startswith("-") or re.search(r"://|\s@\s|^[./~]", s):
        return None
    s = re.sub(r"\s+--hash[=\s]\S+", "", s.split(";")[0]).strip()
    m = _REQ.match(s)
    if not m:
        return None
    return _pep503(m.group(1)) + (re.sub(r"\s+", "", m.group(3)) if m.group(3) else "")


def _poetry_spec(name: str, spec: str) -> Optional[str]:
    v = spec.strip()
    if not v or v == "*":
        return _pep503(name)
    if re.match(r"^[\^~]=?\s*\d", v):
        out = ">=" + re.sub(r"^[\^~]=?\s*", "", v)
    elif re.match(r"^\d", v):
        out = "==" + v
    else:
        out = re.sub(r"\s+", "", v)
    return normalize_requirement(_pep503(name) + out)


def _toml_sections(text: str) -> List[Tuple[str, str]]:
    out: List[Tuple[str, str]] = []
    last: Optional[Tuple[str, int]] = None
    for m in re.finditer(r"^\s*\[([^\[\]\n]+)\]\s*$", text, re.M):
        if last:
            out.append((last[0], text[last[1]:m.start()]))
        last = (m.group(1).strip(), m.end())
    if last:
        out.append((last[0], text[last[1]:]))
    return out


def _toml_strings(s: str) -> List[str]:
    return [a if a or not b else b for a, b in re.findall(r"\"((?:[^\"\\]|\\.)*)\"|'([^']*)'", s)]


def _toml_array(body: str, key: str) -> List[str]:
    m = re.search(r"^\s*" + re.escape(key) + r"\s*=\s*\[([\s\S]*?)\]", body, re.M)
    return _toml_strings(re.sub(r"#[^\n]*", "", m.group(1))) if m else []


def _parse_pyproject(text: str, reqs: Set[str]) -> None:
    for name, body in _toml_sections(text):
        if name == "project":
            for r in _toml_array(body, "dependencies"):
                n = normalize_requirement(r)
                if n:
                    reqs.add(n)
        elif name in ("project.optional-dependencies", "dependency-groups"):
            for m in re.finditer(r"^\s*[\w.-]+\s*=\s*\[([\s\S]*?)\]", body, re.M):
                for r in _toml_strings(re.sub(r"#[^\n]*", "", m.group(1))):
                    n = normalize_requirement(r)
                    if n:
                        reqs.add(n)
        elif re.match(r"^tool\.poetry\.(?:dev-dependencies|dependencies|group\.[\w.-]+\.dependencies)$", name):
            for m in re.finditer(r"^\s*([A-Za-z0-9][\w.-]*)\s*=\s*(.+)$", body, re.M):
                if m.group(1).lower() == "python":
                    continue
                val = m.group(2).strip()
                spec: Optional[str] = None
                if val[:1] in ("'", '"'):
                    st = _toml_strings(val)
                    spec = st[0] if st else None
                elif val.startswith("{"):
                    if re.search(r"\b(?:path|git|url|file)\s*=", val):
                        continue
                    v = re.search(r"\bversion\s*=\s*[\"']([^\"']*)[\"']", val)
                    spec = v.group(1) if v else "*"
                if spec is None:
                    continue
                n = _poetry_spec(m.group(1), spec)
                if n:
                    reqs.add(n)


def _parse_py_lock(text: str, pkgs: Set[str]) -> None:
    for b in re.split(r"^\s*\[\[package\]\]\s*$", text, flags=re.M)[1:]:
        body = re.split(r"^\s*\[\[", b, flags=re.M)[0]
        n = re.search(r"^\s*name\s*=\s*\"([^\"]+)\"", body, re.M)
        v = re.search(r"^\s*version\s*=\s*\"([^\"]+)\"", body, re.M)
        if not n or not v:
            continue
        if re.search(r"^\s*source\s*=\s*\{[^}]*\b(?:editable|virtual|path|directory|git|url)\s*=", body, re.M):
            continue
        if re.search(r"\[package\.source\][\s\S]*?\btype\s*=\s*\"(?:git|directory|file|url)\"", body):
            continue
        pkgs.add(f"pypi:{_pep503(n.group(1))}=={v.group(1)}")


def _parse_npm_lock(text: str, pkgs: Set[str]) -> None:
    try:
        j = json.loads(text)
    except ValueError:
        return

    def ok(e: Any) -> bool:
        return (isinstance(e, dict) and isinstance(e.get("version"), str) and not e.get("link")
                and not (isinstance(e.get("resolved"), str) and re.match(r"^(?:file|git|link)[:+]", e["resolved"]))
                and not _NON_REGISTRY_SPEC.search(e["version"]))

    if isinstance(j, dict) and isinstance(j.get("packages"), dict):
        for k, e in j["packages"].items():
            parts = k.split("node_modules/")
            if len(parts) != 2 or parts[0] != "" or not ok(e):
                continue
            pkgs.add(f"npm:{parts[1]}@{e['version']}")
    elif isinstance(j, dict) and isinstance(j.get("dependencies"), dict):
        for k, e in j["dependencies"].items():
            if ok(e):
                pkgs.add(f"npm:{k}@{e['version']}")


def _parse_yarn_lock(text: str, pkgs: Set[str]) -> None:
    rx = re.compile(r"^\"?((?:@[^@\s\"/]+/)?[^@\s\"/,]+)@([^\n]*?)\"?:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+version:?\s+\"?([^\"\s]+)\"?", re.M)
    for m in rx.finditer(text):
        if re.search(r"workspace:|file:|link:|portal:|patch:|git|https?:", m.group(2)):
            continue
        pkgs.add(f"npm:{m.group(1)}@{m.group(3)}")


def _parse_pipfile_lock(text: str, pkgs: Set[str]) -> None:
    try:
        j = json.loads(text)
    except ValueError:
        return
    for sec in ("default", "develop"):
        for k, e in ((j or {}).get(sec) or {}).items():
            if isinstance(e, dict) and isinstance(e.get("version"), str) and e["version"].startswith("=="):
                pkgs.add(f"pypi:{_pep503(k)}{e['version']}")


def _workflow_uses(text: str, uses: Set[str]) -> None:
    for m in re.finditer(r"^\s*(?:-\s*)?uses:\s*[\"']?([^\s\"'#]+)", str(text), re.M):
        ref = m.group(1)
        if ref.startswith("./") or ref.startswith("docker://") or not re.match(r"^[\w.-]+/[\w./-]+@[\w./-]+$", ref):
            continue
        uses.add(ref)


def _node_major(s: str) -> Optional[str]:
    m = re.match(r"^\s*v?(\d{1,2})(?:\.\d+){0,2}\s*$", s)
    return m.group(1) if m else None


def _set_runtime(rt: Dict[str, str], k: str, v: Optional[str]) -> None:
    if v and k not in rt:
        rt[k] = v


def _from_runtime_file(name: str, text: str, rt: Dict[str, str]) -> bool:
    lower = name.lower()
    if lower in (".nvmrc", ".node-version"):
        _set_runtime(rt, "node", _node_major(text.split("\n")[0]))
        return True
    if lower == ".python-version":
        m = re.match(r"^\s*(\d+\.\d+)", text)
        _set_runtime(rt, "python", m.group(1) if m else None)
        return True
    if lower == "runtime.txt":
        m = re.search(r"python-(\d+\.\d+)", text)
        _set_runtime(rt, "python", m.group(1) if m else None)
        return True
    if lower == "vercel.json":
        m = re.search(r"nodejs(\d{2})\.x", text)
        _set_runtime(rt, "node", m.group(1) if m else None)
        return True
    if lower == "netlify.toml":
        m = re.search(r"NODE_VERSION\s*=\s*[\"']?v?(\d{1,2})", text)
        _set_runtime(rt, "node", m.group(1) if m else None)
        return True
    return False


def normalize_stack(inp: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Parse a stack input locally. Returns {"body": exact request body (facts only), "ignored": [file names]}."""
    inp = dict(inp or {})
    deps: Dict[str, Dict[str, str]] = {}
    engines: Dict[str, str] = {}
    pkgs: Set[str] = set()
    reqs: Set[str] = set()
    uses: Set[str] = set()
    rt: Dict[str, str] = {}
    ignored: List[str] = []

    def add_package_json(pj: Any) -> None:
        if isinstance(pj, str):
            try:
                pj = json.loads(pj)
            except ValueError:
                return
        if not isinstance(pj, dict):
            return
        for k in _DEP_KEYS:
            c = _clean_deps(pj.get(k))
            if c:
                deps[k] = {**deps.get(k, {}), **c}
        for k, v in (pj.get("engines") or {}).items() if isinstance(pj.get("engines"), dict) else ():
            if isinstance(v, str) and re.match(r"^[\w-]+$", str(k)):
                engines[k] = v[:64]

    def add_req_text(t: str) -> None:
        for line in re.split(r"\r?\n", str(t)):
            n = normalize_requirement(line)
            if n:
                reqs.add(n)

    for k in _DEP_KEYS:
        c = _clean_deps(inp.get(k))
        if c:
            deps[k] = {**deps.get(k, {}), **c}
    if inp.get("engines"):
        add_package_json({"engines": inp["engines"]})
    if isinstance(inp.get("packages"), list):
        for p in inp["packages"]:
            if isinstance(p, str) and p.strip() and "://" not in p:
                pkgs.add(p.strip()[:200])
    r0 = inp.get("runtime")
    if isinstance(r0, dict):
        for k, v in r0.items():
            if isinstance(v, (str, int, float)) and not isinstance(v, bool) and re.match(r"^[\w-]+$", str(k)):
                rt[k] = str(v)[:32]
    elif isinstance(r0, str):
        m = re.match(r"^(node|python)\s*@?\s*v?(\d+(?:\.\d+)?)", r0, re.I)
        if m:
            rt[m.group(1).lower()] = m.group(2)
    if inp.get("package_json"):
        add_package_json(inp["package_json"])
    if isinstance(inp.get("requirements_txt"), str):
        add_req_text(inp["requirements_txt"])
    if isinstance(inp.get("requirements"), str):
        add_req_text(inp["requirements"])
    if isinstance(inp.get("pyproject_toml"), str):
        _parse_pyproject(inp["pyproject_toml"], reqs)
    if isinstance(inp.get("workflows"), list):
        for w in inp["workflows"]:
            _workflow_uses(str(w), uses)
    for key, fname in (("nvmrc", ".nvmrc"), ("netlify_toml", "netlify.toml"), ("vercel_json", "vercel.json")):
        if isinstance(inp.get(key), str):
            _from_runtime_file(fname, inp[key], rt)

    f = inp.get("files")
    files: List[Tuple[str, str]] = []
    if isinstance(f, list):
        files = [(str((x or {}).get("path") or ""), str((x or {}).get("content") or "")) for x in f if isinstance(x, dict)]
    elif isinstance(f, dict):
        files = [(str(p), "" if c is None else str(c)) for p, c in f.items()]
    for path, text in files:
        name = _base(path)
        lower = name.lower()
        norm = path.replace("\\", "/")
        if lower == "package.json":
            add_package_json(text)
        elif lower in ("package-lock.json", "npm-shrinkwrap.json"):
            _parse_npm_lock(text, pkgs)
        elif lower == "yarn.lock":
            _parse_yarn_lock(text, pkgs)
        elif lower in ("poetry.lock", "uv.lock"):
            _parse_py_lock(text, pkgs)
        elif lower == "pipfile.lock":
            _parse_pipfile_lock(text, pkgs)
        elif lower == "pyproject.toml":
            _parse_pyproject(text, reqs)
        elif re.match(r"^requirements[\w.-]*\.(?:txt|in)$", lower) or lower == "constraints.txt":
            add_req_text(text)
        elif _from_runtime_file(name, text, rt):
            pass
        elif re.search(r"(?:^|/)\.github/workflows/[^/]+\.ya?ml$", norm, re.I) or (re.search(r"\.ya?ml$", lower, re.I) and re.search(r"^\s*(?:-\s*)?uses:", text, re.M)):
            _workflow_uses(text, uses)
        else:
            ignored.append(name)

    body: Dict[str, Any] = {}
    if isinstance(inp.get("services"), list):
        body["services"] = [s[:64] for s in inp["services"] if isinstance(s, str)]
    if inp.get("ecosystem") in ("npm", "pypi"):
        body["ecosystem"] = inp["ecosystem"]
    for k in _DEP_KEYS:
        if deps.get(k):
            body[k] = dict(sorted(deps[k].items()))
    if engines:
        body["engines"] = dict(sorted(engines.items()))
    if pkgs:
        body["packages"] = sorted(pkgs)[:MAX_PACKAGES]
    if reqs:
        body["requirements"] = "\n".join(sorted(reqs))
    if rt:
        body["runtime"] = dict(sorted(rt.items()))
    if uses:
        body["workflows"] = ["\n".join(f"uses: {u}" for u in sorted(uses))]
    # 0.7.0 (server 0.9.0+): model ids, feature flags and installed versions are facts: cleaned and passed through
    for key in ("models", "features"):
        vals = inp.get(key)
        if isinstance(vals, (list, tuple)):
            seen: List[str] = []
            for x in vals:
                if isinstance(x, str) and x.strip() and "://" not in x and x.strip()[:100] not in seen:
                    seen.append(x.strip()[:100])
            if seen:
                body[key] = seen[:50]
    inst = inp.get("installed")
    if isinstance(inst, dict):
        clean = {str(k): str(v)[:64] for k, v in inst.items() if isinstance(v, (str, int, float)) and re.match(r"^[@\w./:-]{1,214}$", str(k))}
        if clean:
            body["installed"] = dict(sorted(clean.items()))
    for k, v in inp.items():
        if k in ("models", "features", "installed"):
            continue
        if k in _RAW_KEYS or k in body or k in STACK_FIELDS:
            continue
        if isinstance(v, (bool, int, float)):
            body[k] = v
    return {"body": body, "ignored": ignored}
