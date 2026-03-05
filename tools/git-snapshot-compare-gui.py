#!/usr/bin/env python3

import argparse
import difflib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


class CompareGuiError(RuntimeError):
    pass


class CompareData:
    def __init__(self, target_fields, rows, summary_fields):
        self.target_fields = target_fields
        self.rows = rows
        self.summary_fields = summary_fields


def _run(cmd, cwd=None, check=True):
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    if check and proc.returncode != 0:
        raise CompareGuiError(
            f"Command failed ({proc.returncode}): {' '.join(cmd)}\n"
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )
    return proc


def _parse_porcelain(stdout_text):
    target = {}
    rows = []
    summary = {}

    for raw_line in stdout_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split("\t")
        kind = parts[0]
        fields = {}
        for kv in parts[1:]:
            if "=" not in kv:
                continue
            key, value = kv.split("=", 1)
            fields[key] = value

        if kind == "compare_target":
            target = fields
        elif kind == "compare_file":
            rows.append(fields)
        elif kind == "compare_summary":
            summary = fields

    return CompareData(target, rows, summary)


def load_compare_data(git_snapshot_bin, snapshot_id, repo_filter, show_all):
    cmd = [git_snapshot_bin, "compare", snapshot_id, "--porcelain"]
    if repo_filter:
        cmd.extend(["--repo", repo_filter])
    if show_all:
        cmd.append("--all")

    proc = _run(cmd, check=False)
    if proc.returncode != 0:
        raise CompareGuiError(
            f"Failed to load compare data (exit {proc.returncode}).\n"
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )
    return _parse_porcelain(proc.stdout)


def load_repos_map(snapshot_dir):
    repos_tsv = snapshot_dir / "repos.tsv"
    if not repos_tsv.exists():
        raise CompareGuiError(f"Snapshot metadata missing: {repos_tsv}")

    repos_map = {}
    for line in repos_tsv.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        repo_id, repo_rel, snapshot_head = parts[0], parts[1], parts[2]
        repos_map[repo_rel] = {
            "repo_id": repo_id,
            "snapshot_head": snapshot_head,
        }
    return repos_map


def repo_worktree_exists(repo_abs):
    proc = subprocess.run(
        ["git", "-C", str(repo_abs), "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def is_binary(data_bytes):
    return b"\x00" in data_bytes


def _repo_component(repo_rel):
    return "__root__" if repo_rel == "." else repo_rel


class SnapshotFileResolver:
    def __init__(self, root_repo, snapshot_id):
        self.root_repo = Path(root_repo).resolve()
        self.snapshot_id = snapshot_id
        self.snapshot_dir = Path.home() / "git-snapshots" / self.root_repo.name / snapshot_id
        self.repos_map = load_repos_map(self.snapshot_dir)

        self.session_dir = Path(tempfile.gettempdir()) / f"git-snapshot-gui.{os.getpid()}"
        self.snapshot_files_dir = self.session_dir / "snapshot-files"
        self.repo_work_dir = self.session_dir / "repo-work"
        self.snapshot_files_dir.mkdir(parents=True, exist_ok=True)
        self.repo_work_dir.mkdir(parents=True, exist_ok=True)

    def materialize_snapshot_file(self, repo_rel, file_path):
        repo_meta = self.repos_map.get(repo_rel)
        if repo_meta is None:
            raise CompareGuiError(f"Repo [{repo_rel}] not found in snapshot metadata.")

        repo_abs = self.root_repo / repo_rel
        if not repo_worktree_exists(repo_abs):
            raise CompareGuiError(
                f"Repo path missing in working tree: {repo_abs}\n"
                "Restore/check out repo and refresh."
            )

        repo_component = _repo_component(repo_rel)
        temp_repo = self.repo_work_dir / repo_component
        if temp_repo.exists():
            shutil.rmtree(temp_repo)
        temp_repo.mkdir(parents=True, exist_ok=True)
        _run(["git", "-C", str(temp_repo), "init", "-q"])

        temp_repo_file = temp_repo / file_path
        temp_repo_file.parent.mkdir(parents=True, exist_ok=True)

        snapshot_head = repo_meta["snapshot_head"]
        show_proc = subprocess.run(
            ["git", "-C", str(repo_abs), "show", f"{snapshot_head}:{file_path}"],
            capture_output=True,
        )
        if show_proc.returncode == 0:
            temp_repo_file.write_bytes(show_proc.stdout)

        patch_base = self.snapshot_dir / "repos" / repo_meta["repo_id"]
        for patch_name in ("staged.patch", "unstaged.patch"):
            patch_path = patch_base / patch_name
            if not patch_path.exists() or patch_path.stat().st_size == 0:
                continue
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(temp_repo),
                    "apply",
                    "--unsafe-paths",
                    f"--include={file_path}",
                    str(patch_path),
                ],
                capture_output=True,
            )

        snapshot_out = self.snapshot_files_dir / repo_component / file_path
        snapshot_out.parent.mkdir(parents=True, exist_ok=True)
        if temp_repo_file.exists():
            shutil.copy2(temp_repo_file, snapshot_out)
        else:
            snapshot_out.write_text("", encoding="utf-8")
        return snapshot_out

    def current_file_path(self, repo_rel, file_path):
        return self.root_repo / repo_rel / file_path


def build_unified_diff(current_file, snapshot_file, rel_file_path):
    current_bytes = current_file.read_bytes() if current_file.exists() else b""
    snapshot_bytes = snapshot_file.read_bytes() if snapshot_file.exists() else b""

    if is_binary(current_bytes) or is_binary(snapshot_bytes):
        return "Binary/non-text diff preview unavailable; use external tool."

    current_text = current_bytes.decode("utf-8", errors="replace").splitlines(keepends=True)
    snapshot_text = snapshot_bytes.decode("utf-8", errors="replace").splitlines(keepends=True)

    diff_lines = list(
        difflib.unified_diff(
            current_text,
            snapshot_text,
            fromfile=f"current:{rel_file_path}",
            tofile=f"snapshot:{rel_file_path}",
        )
    )
    if not diff_lines:
        return "No textual differences."
    return "".join(diff_lines)


def detect_external_diff_tool():
    for candidate in ("meld", "opendiff", "code"):
        if shutil.which(candidate):
            return candidate
    return None


def launch_external_diff(tool, snapshot_file, current_file):
    if tool == "code":
        cmd = [tool, "--diff", str(snapshot_file), str(current_file)]
    else:
        cmd = [tool, str(snapshot_file), str(current_file)]
    subprocess.Popen(cmd)


def run_test_mode(args):
    compare_data = load_compare_data(
        args.git_snapshot_bin,
        args.snapshot_id,
        args.repo_filter,
        args.show_all == "true",
    )
    resolver = SnapshotFileResolver(args.root_repo, args.snapshot_id)

    if compare_data.rows:
        row = compare_data.rows[0]
        repo_rel = row.get("repo", "")
        file_path = row.get("file", "")
        if repo_rel and file_path:
            try:
                snapshot_file = resolver.materialize_snapshot_file(repo_rel, file_path)
                current_file = resolver.current_file_path(repo_rel, file_path)
                _ = build_unified_diff(current_file, snapshot_file, file_path)
            except CompareGuiError:
                pass

    print(
        f"GUI_TEST snapshot_id={args.snapshot_id} "
        f"rows={len(compare_data.rows)} show_all={args.show_all}"
    )
    return 0


class CompareGuiApp:
    def __init__(self, args):
        self.args = args
        self.compare_data = None
        self.resolver = SnapshotFileResolver(args.root_repo, args.snapshot_id)
        self.selected_row = None
        self.item_to_row = {}

        import tkinter as tk
        from tkinter import ttk, messagebox, scrolledtext

        self.tk = tk
        self.ttk = ttk
        self.messagebox = messagebox
        self.scrolledtext = scrolledtext

        self.root = tk.Tk()
        self.root.title("git-snapshot compare --gui")
        self.root.geometry("1400x860")

        self.status_var = tk.StringVar(value="Ready.")
        self.summary_var = tk.StringVar(value="")
        self.target_var = tk.StringVar(value="")

        self._build_ui()

    def _build_ui(self):
        top = self.ttk.Frame(self.root)
        top.pack(fill="x", padx=8, pady=6)

        self.ttk.Label(top, textvariable=self.target_var).pack(anchor="w")
        self.ttk.Label(top, textvariable=self.summary_var).pack(anchor="w")

        controls = self.ttk.Frame(top)
        controls.pack(fill="x", pady=(6, 0))
        self.refresh_button = self.ttk.Button(controls, text="Refresh", command=self.refresh)
        self.refresh_button.pack(side="left")
        self.open_button = self.ttk.Button(
            controls, text="Open in Meld", command=self.open_in_external_diff, state="disabled"
        )
        self.open_button.pack(side="left", padx=(6, 0))

        main = self.ttk.Panedwindow(self.root, orient="horizontal")
        main.pack(fill="both", expand=True, padx=8, pady=6)

        left = self.ttk.Frame(main)
        right = self.ttk.Frame(main)
        main.add(left, weight=1)
        main.add(right, weight=2)

        self.tree = self.ttk.Treeview(left, show="tree")
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<<TreeviewSelect>>", self.on_tree_select)

        self.diff_text = self.scrolledtext.ScrolledText(
            right, wrap="none", font=("Menlo", 11)
        )
        self.diff_text.pack(fill="both", expand=True)
        self.diff_text.configure(state="disabled")

        status_bar = self.ttk.Label(self.root, textvariable=self.status_var, relief="sunken", anchor="w")
        status_bar.pack(fill="x", side="bottom")

    def set_diff_preview(self, text):
        self.diff_text.configure(state="normal")
        self.diff_text.delete("1.0", self.tk.END)
        self.diff_text.insert("1.0", text)
        self.diff_text.configure(state="disabled")

    def refresh(self):
        try:
            self.compare_data = load_compare_data(
                self.args.git_snapshot_bin,
                self.args.snapshot_id,
                self.args.repo_filter,
                self.args.show_all == "true",
            )
        except CompareGuiError as err:
            self.messagebox.showerror("Compare Load Error", str(err))
            return

        target = self.compare_data.target_fields
        summary = self.compare_data.summary_fields
        self.target_var.set(
            f"Snapshot: {target.get('selected_snapshot_id', self.args.snapshot_id)} | "
            f"Mode: {target.get('selection_mode', self.args.selection_mode)} | "
            f"Repo filter: {self.args.repo_filter or '(all)'} | "
            f"Rows: {'all statuses' if self.args.show_all == 'true' else 'unresolved only'}"
        )
        self.summary_var.set(
            f"repos_checked={summary.get('repos_checked', '?')} "
            f"files_total={summary.get('files_total', '?')} "
            f"unresolved_total={summary.get('unresolved_total', '?')} "
            f"shown_files={summary.get('shown_files', '?')}"
        )

        self.tree.delete(*self.tree.get_children())
        self.item_to_row = {}
        self.selected_row = None
        self.open_button.configure(state="disabled")
        self.set_diff_preview("Select a file to preview diff.")

        repo_nodes = {}
        for row in self.compare_data.rows:
            repo_rel = row.get("repo", "")
            file_path = row.get("file", "")
            status = row.get("status", "")
            if not repo_rel or not file_path:
                continue
            if repo_rel not in repo_nodes:
                repo_nodes[repo_rel] = self.tree.insert("", "end", text=repo_rel, open=True)
            row_text = f"{file_path} [{status}]"
            item = self.tree.insert(repo_nodes[repo_rel], "end", text=row_text)
            self.item_to_row[item] = row

        if not self.compare_data.rows:
            self.status_var.set("No rows to display for current visibility filter.")
        else:
            self.status_var.set("Loaded compare rows. Select a file for diff preview.")

    def on_tree_select(self, _event):
        selection = self.tree.selection()
        if not selection:
            return
        item = selection[0]
        row = self.item_to_row.get(item)
        if row is None:
            self.selected_row = None
            self.open_button.configure(state="disabled")
            return

        self.selected_row = row
        repo_rel = row.get("repo", "")
        file_path = row.get("file", "")
        repo_abs = self.resolver.root_repo / repo_rel
        if repo_worktree_exists(repo_abs):
            self.open_button.configure(state="normal")
        else:
            self.open_button.configure(state="disabled")

        try:
            snapshot_file = self.resolver.materialize_snapshot_file(repo_rel, file_path)
            current_file = self.resolver.current_file_path(repo_rel, file_path)
            diff_text = build_unified_diff(current_file, snapshot_file, file_path)
            self.set_diff_preview(diff_text)
            self.status_var.set(f"Preview ready for {repo_rel}/{file_path}")
        except CompareGuiError as err:
            self.set_diff_preview(str(err))
            self.status_var.set("Cannot materialize snapshot file for preview.")

    def open_in_external_diff(self):
        if self.selected_row is None:
            return

        tool = detect_external_diff_tool()
        if tool is None:
            self.messagebox.showerror(
                "External Diff Tool Missing",
                "No external diff tool found. Install meld, opendiff, or code.",
            )
            return

        repo_rel = self.selected_row.get("repo", "")
        file_path = self.selected_row.get("file", "")
        repo_abs = self.resolver.root_repo / repo_rel
        if not repo_worktree_exists(repo_abs):
            self.messagebox.showwarning(
                "Repo Missing",
                f"Repo path missing in working tree: {repo_abs}\n"
                "Restore/check out repo and refresh.",
            )
            return

        try:
            snapshot_file = self.resolver.materialize_snapshot_file(repo_rel, file_path)
            current_file = self.resolver.current_file_path(repo_rel, file_path)
            current_file.parent.mkdir(parents=True, exist_ok=True)
            if not current_file.exists():
                current_file.write_text("", encoding="utf-8")

            # Locked order: snapshot temp on left, current file on right.
            launch_external_diff(tool, snapshot_file, current_file)
            self.status_var.set(f"Opened {tool} for {repo_rel}/{file_path}")
        except CompareGuiError as err:
            self.messagebox.showerror("Open Diff Failed", str(err))

    def run(self):
        self.refresh()
        self.root.mainloop()


def parse_args(argv):
    parser = argparse.ArgumentParser(description="git-snapshot compare GUI")
    parser.add_argument("--root-repo", required=True)
    parser.add_argument("--snapshot-id", required=True)
    parser.add_argument("--selection-mode", required=True)
    parser.add_argument("--repo-filter", default="")
    parser.add_argument("--show-all", required=True, choices=("true", "false"))
    parser.add_argument("--git-snapshot-bin", required=True)
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    if os.environ.get("GIT_SNAPSHOT_GUI_TEST_MODE") == "1":
        return run_test_mode(args)

    try:
        app = CompareGuiApp(args)
        app.run()
    except CompareGuiError as err:
        print(str(err), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
