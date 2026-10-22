"""Runs one Python test file with unittest and writes every test's outcome as JSON.

    python3 run_py_tests.py <checkout> <file relative to checkout> <report.json> ['["src"]']

The report is {"tests": [{"name": "Class.test_method", "outcome": "pass" | "fail" | "skip"}]}. The file is loaded the
way `python3 -m unittest discover` would load it (as part of its package when its folder is a package), with the
checkout, the extra folders given (for example "src") and the file's own folder on the import path. A file that cannot
be imported is one failing test, "(import)". Python 3.9 and newer; standard library only.
"""
import io
import json
import os
import sys
import unittest


class Outcomes(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self.buffer = True
        self.outcomes = {}

    def _set(self, test, outcome):
        name = name_of(test)
        rank = {"fail": 3, "skip": 2, "pass": 1}
        if name not in self.outcomes or rank[outcome] > rank[self.outcomes[name]]:
            self.outcomes[name] = outcome

    def addSuccess(self, test):
        super().addSuccess(test)
        self._set(test, "pass")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._set(test, "fail")

    def addError(self, test, err):
        super().addError(test, err)
        self._set(test, "fail")

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._set(test, "skip")

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._set(test, "pass")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._set(test, "fail")

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            self._set(test, "fail")


def name_of(test):
    test_id = test.id()
    if test_id.startswith("unittest.loader._FailedTest") or type(test).__name__ == "_FailedTest":
        return "(import)"
    if type(test).__name__ == "_ErrorHolder":
        return "(setup)"
    return ".".join(test_id.split(".")[-2:])


def top_level(start, checkout):
    """The folder discover would treat as the top: above the outermost package that holds the test file."""
    top = start
    while os.path.exists(os.path.join(top, "__init__.py")) and os.path.dirname(top) != top:
        parent = os.path.dirname(top)
        if not os.path.realpath(parent).startswith(os.path.realpath(checkout)):
            break
        top = parent
    return top


def main():
    checkout, rel, report = sys.argv[1], sys.argv[2], sys.argv[3]
    extra = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
    path = os.path.join(checkout, rel)
    start = os.path.dirname(path)
    for folder in [start, checkout] + [os.path.join(checkout, e) for e in reversed(extra)]:
        if folder not in sys.path:
            sys.path.insert(0, folder)
    result = Outcomes()
    error = None
    try:
        suite = unittest.defaultTestLoader.discover(start, pattern=os.path.basename(path), top_level_dir=top_level(start, checkout))
        saved = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = io.StringIO(), io.StringIO()
        try:
            suite.run(result)
        finally:
            sys.stdout, sys.stderr = saved
        for test, trace in result.errors:
            if name_of(test) in ("(import)", "(setup)"):
                error = trace.strip().splitlines()[-1][:400]
    except Exception as exc:  # the loader itself failed: the file cannot be imported
        result.outcomes["(import)"] = "fail"
        error = repr(exc)[:400]
    tests = [{"name": name, "outcome": outcome} for name, outcome in result.outcomes.items()]
    body = {"tests": tests}
    if error:
        body["error"] = error
    with open(report, "w", encoding="utf-8") as handle:
        json.dump(body, handle)


if __name__ == "__main__":
    main()
