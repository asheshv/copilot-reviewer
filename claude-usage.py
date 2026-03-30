#!/usr/bin/env python3
"""
claude-usage.py — Print Claude Code usage: cost, model tokens, session time.

Reports per-session, per-day, per-project, and overall summary.

Usage:
  python3 claude-usage.py [--days N] [--project SUBSTR]
"""

import argparse
import glob
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta

# ── Pricing (per million tokens) ──────────────────────────────────────────────
# Update when Anthropic changes pricing.
PRICING = {
    "claude-opus-4-6":   {"input": 15.00, "output": 75.00, "cache_write": 18.75, "cache_read": 1.50},
    "claude-opus-4-5":   {"input": 15.00, "output": 75.00, "cache_write": 18.75, "cache_read": 1.50},
    "claude-sonnet-4-6": {"input":  3.00, "output": 15.00, "cache_write":  3.75, "cache_read": 0.30},
    "claude-sonnet-4-5": {"input":  3.00, "output": 15.00, "cache_write":  3.75, "cache_read": 0.30},
    "claude-haiku-4-5":  {"input":  0.80, "output":  4.00, "cache_write":  1.00, "cache_read": 0.08},
}
DEFAULT_PRICING = {"input": 15.00, "output": 75.00, "cache_write": 18.75, "cache_read": 1.50}

CLAUDE_HOME = os.path.expanduser("~/.claude")


def get_pricing(model: str) -> dict:
    for key, p in PRICING.items():
        if model.startswith(key):
            return p
    return DEFAULT_PRICING


def compute_cost(model: str, usage: dict) -> float:
    p = get_pricing(model)
    return (
        usage.get("input", 0) * p["input"] / 1_000_000
        + usage.get("output", 0) * p["output"] / 1_000_000
        + usage.get("cache_write", 0) * p["cache_write"] / 1_000_000
        + usage.get("cache_read", 0) * p["cache_read"] / 1_000_000
    )


_decoded_path_cache: dict[str, str] = {}


def decode_project_path(dir_name: str) -> str:
    """Convert dir name like -Users-ashesh-vashi-Projects-Foo to a display path.

    Claude's encoding replaces both / and . with -, so we greedily reconstruct
    by trying candidate path components against the filesystem, considering
    that - could be /, -, or . in the original.

    Since these dirs live under ~/.claude/projects/, the home dir prefix is
    known and doesn't need filesystem resolution.
    """
    if dir_name in _decoded_path_cache:
        return _decoded_path_cache[dir_name]

    home = os.path.expanduser("~")
    home_encoded = home.replace("/", "-").lstrip("-")  # e.g. "Users-ashesh.vashi"

    # Strip leading dash from dir_name
    stripped = dir_name.lstrip("-")

    if stripped.startswith(home_encoded):
        # Skip home prefix — resolve only the remainder
        remainder = stripped[len(home_encoded):].lstrip("-")
        if remainder:
            segments = remainder.split("-")
            result = _resolve_segments(segments, home)
        else:
            result = home
    else:
        # Shouldn't happen for ~/.claude/projects/ dirs, but fall back
        segments = stripped.split("-")
        result = _resolve_segments(segments, "/")

    if result.startswith(home):
        result = "~" + result[len(home):]
    _decoded_path_cache[dir_name] = result
    return result


def _resolve_segments(segments: list[str], base: str) -> str:
    """Greedily resolve segments into a filesystem path.

    At each step, try joining multiple segments with . or - to form a single
    path component, preferring the longest match that exists on disk.
    """
    i = 0
    path = base
    while i < len(segments):
        matched = False
        # Try longest multi-segment component first
        for j in range(len(segments), i, -1):
            for sep in _join_combos(segments[i:j]):
                test_path = os.path.join(path, sep)
                if os.path.exists(test_path):
                    path = test_path
                    i = j
                    matched = True
                    break
            if matched:
                break
        if not matched:
            # No match — just append as-is with /
            path = os.path.join(path, segments[i])
            i += 1
    return path


def _join_combos(parts: list[str]) -> list[str]:
    """Generate join candidates for a list of segments.

    For efficiency, only try: all-dashes, all-dots, and the original (single
    segment). This covers the common cases (dotted usernames, hyphenated dirs).
    """
    if len(parts) == 1:
        return [parts[0]]
    return [
        "-".join(parts),
        ".".join(parts),
    ]


def _get_project_cwd(project_dir: str) -> str | None:
    """Get the actual CWD for a project dir by peeking at a session's cwd field."""
    for jsonl_path in glob.glob(os.path.join(project_dir, "*.jsonl")):
        with open(jsonl_path) as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("cwd"):
                    return obj["cwd"]
        break  # only need to check one file
    return None


def _parse_ts(ts_str: str) -> datetime | None:
    try:
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def parse_session(jsonl_path: str) -> dict | None:
    """Parse a session JSONL and return aggregated stats, or None if empty."""
    model_usage = defaultdict(lambda: {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0})
    timestamps = []

    # For API time: collect (role, timestamp) pairs
    role_timestamps = []

    with open(jsonl_path) as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            ts = _parse_ts(obj.get("timestamp", ""))
            if ts:
                timestamps.append(ts)

            msg = obj.get("message", {})
            if not isinstance(msg, dict):
                continue

            role = msg.get("role")
            if role and ts:
                role_timestamps.append((role, ts))

            usage = msg.get("usage")
            model = msg.get("model")
            if not usage or not model:
                continue

            u = model_usage[model]
            u["input"] += usage.get("input_tokens", 0)
            u["output"] += usage.get("output_tokens", 0)
            u["cache_write"] += usage.get("cache_creation_input_tokens", 0)
            u["cache_read"] += usage.get("cache_read_input_tokens", 0)

    if not model_usage or not timestamps:
        return None

    total_cost = sum(compute_cost(m, u) for m, u in model_usage.items())
    start = min(timestamps)
    end = max(timestamps)
    duration = end - start

    # Compute API time: sum of each user→last_assistant turn span.
    # A "turn" starts at a user message and ends at the last assistant message
    # before the next user message (that isn't an auto-injected tool result,
    # i.e. has >1s gap from the preceding assistant).
    api_time = timedelta()
    turn_start = None
    turn_end = None
    for role, ts in role_timestamps:
        if role == "user":
            # Close previous turn if open
            if turn_start and turn_end:
                api_time += turn_end - turn_start
            turn_start = ts
            turn_end = None
        elif role == "assistant":
            turn_end = ts
    # Close final turn
    if turn_start and turn_end:
        api_time += turn_end - turn_start

    return {
        "session_id": os.path.basename(jsonl_path).replace(".jsonl", ""),
        "start": start,
        "end": end,
        "duration": duration,
        "api_time": api_time,
        "model_usage": dict(model_usage),
        "total_cost": total_cost,
    }


# ── Formatting helpers ─────────────────────────────────────────────────────────

RESET  = "\033[0m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
YELLOW = "\033[33m"
GREEN  = "\033[32m"
CYAN   = "\033[36m"
BLUE   = "\033[34m"


def fmt_duration(td: timedelta) -> str:
    total = int(td.total_seconds())
    if total < 60:
        return f"{total}s"
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m"
    return f"{m}m{s:02d}s"


def fmt_cost(cost: float) -> str:
    return f"{YELLOW}${cost:.2f}{RESET}"


def fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}k"
    return str(n)


def print_model_usage(model_usage: dict, indent: str = "    "):
    for model, u in sorted(model_usage.items()):
        cost = compute_cost(model, u)
        total_tok = u["input"] + u["output"] + u["cache_write"] + u["cache_read"]
        print(
            f"{indent}{DIM}{model}{RESET}  "
            f"in={fmt_tokens(u['input'])} out={fmt_tokens(u['output'])} "
            f"cw={fmt_tokens(u['cache_write'])} cr={fmt_tokens(u['cache_read'])}  "
            f"{fmt_cost(cost)}"
        )


def merge_usage(dst: dict, src: dict):
    for model, u in src.items():
        if model not in dst:
            dst[model] = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0}
        for k in ("input", "output", "cache_write", "cache_read"):
            dst[model][k] += u[k]


def _group_by_root_project(data: dict) -> dict:
    """Group subdirectory projects under the shortest common path prefix.

    E.g. ~/Projects/PEM, ~/Projects/PEM/docs, ~/Projects/PEM/server
    all merge under ~/Projects/PEM.
    """
    paths = sorted(data.keys())
    # Find root projects: a path is a root if no other path is a proper prefix of it
    roots = []
    for p in paths:
        if not any(p.startswith(r + "/") for r in roots):
            roots.append(p)

    grouped = defaultdict(lambda: defaultdict(list))
    for project_path, days in data.items():
        # Find which root this belongs to
        root = project_path
        for r in roots:
            if project_path == r or project_path.startswith(r + "/"):
                root = r
                break
        for day, sessions in days.items():
            grouped[root][day].extend(sessions)

    return grouped


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Claude Code usage report")
    parser.add_argument("--days", type=int, default=0, help="Only include sessions from last N days (0 = all)")
    parser.add_argument("--project", type=str, default="", help="Filter by project path substring")
    parser.add_argument("--cwd", action="store_true", help="Only show usage for the current working directory")
    parser.add_argument("--full", action="store_true", help="With --cwd: include sessions from subdirectories of the project. Without --cwd: group subdirectory projects under their root project")
    parser.add_argument("--sessions", action="store_true", help="Show per-day and per-session detail (default: summary only)")
    args = parser.parse_args()

    cutoff = None
    if args.days > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)

    projects_dir = os.path.join(CLAUDE_HOME, "projects")
    project_dirs = sorted(glob.glob(os.path.join(projects_dir, "*")))

    # project_path -> day -> [session]
    data = defaultdict(lambda: defaultdict(list))
    total_sessions = 0
    skipped = 0

    for project_dir in project_dirs:
        dir_name = os.path.basename(project_dir)
        project_path = decode_project_path(dir_name)

        if args.cwd:
            cwd = os.getcwd()
            proj_cwd = _get_project_cwd(project_dir)
            if proj_cwd is None:
                continue
            if args.full:
                # Include CWD and all subdirectories
                if not (proj_cwd == cwd or proj_cwd.startswith(cwd + "/")):
                    continue
            else:
                if proj_cwd != cwd:
                    continue
        elif args.project:
            # Match against both encoded dir name and decoded display path
            needle = args.project.lower()
            if needle not in dir_name.lower() and needle not in project_path.lower():
                continue

        for jsonl_path in sorted(glob.glob(os.path.join(project_dir, "*.jsonl"))):
            session = parse_session(jsonl_path)
            if not session:
                skipped += 1
                continue
            if cutoff and session["start"] < cutoff:
                skipped += 1
                continue
            day = session["start"].astimezone().strftime("%Y-%m-%d")
            data[project_path][day].append(session)
            total_sessions += 1

    if not data:
        print("No sessions found.")
        return

    # ── Group subdirectory projects under common root when --full (without --cwd) ──
    if args.full and not args.cwd:
        data = _group_by_root_project(data)

    # ── Per-project report ────────────────────────────────────────────────────
    grand_cost = 0.0
    grand_usage = {}
    grand_duration = timedelta()
    grand_api_time = timedelta()
    grand_session_count = 0

    for project_path in sorted(data.keys()):
        days = data[project_path]
        all_sessions = [s for day_sessions in days.values() for s in day_sessions]
        proj_cost = sum(s["total_cost"] for s in all_sessions)
        proj_session_count = len(all_sessions)
        proj_duration = sum((s["duration"] for s in all_sessions), timedelta())
        proj_api_time = sum((s["api_time"] for s in all_sessions), timedelta())
        proj_user_time = proj_duration - proj_api_time
        proj_usage = {}
        for s in all_sessions:
            merge_usage(proj_usage, s["model_usage"])

        proj_first = min(s["start"] for s in all_sessions).astimezone().strftime("%Y-%m-%d")
        proj_last = max(s["end"] for s in all_sessions).astimezone().strftime("%Y-%m-%d")

        print(f"\n{BOLD}{CYAN}{project_path}{RESET}")
        print(f"  Sessions: {proj_session_count}  Duration: {fmt_duration(proj_duration)} "
              f"(user: {fmt_duration(proj_user_time)}, assistant: {fmt_duration(proj_api_time)})")
        print(f"  First: {proj_first}  Last: {proj_last}  Cost: {fmt_cost(proj_cost)}")
        if not args.sessions:
            print_model_usage(proj_usage, indent="    ")
        else:
            for day in sorted(days.keys(), reverse=True):
                sessions = days[day]
                day_cost = sum(s["total_cost"] for s in sessions)
                day_duration = sum((s["duration"] for s in sessions), timedelta())
                day_api_time = sum((s["api_time"] for s in sessions), timedelta())
                day_user_time = day_duration - day_api_time
                day_usage = {}
                for s in sessions:
                    merge_usage(day_usage, s["model_usage"])

                print(f"\n  {BOLD}{BLUE}{day}{RESET}  ({len(sessions)} session{'s' if len(sessions)>1 else ''})  "
                      f"{fmt_duration(day_duration)} "
                      f"(user: {fmt_duration(day_user_time)}, assistant: {fmt_duration(day_api_time)})  "
                      f"{fmt_cost(day_cost)}")
                print_model_usage(day_usage, indent="    ")

                for s in sorted(sessions, key=lambda x: x["start"]):
                    local_start = s["start"].astimezone().strftime("%H:%M")
                    user_time = s["duration"] - s["api_time"]
                    print(
                        f"    {DIM}{local_start}{RESET}  "
                        f"{fmt_duration(s['duration'])} "
                        f"(user: {fmt_duration(user_time)}, assistant: {fmt_duration(s['api_time'])})  "
                        f"{DIM}{s['session_id'][:8]}{RESET}  "
                        f"{fmt_cost(s['total_cost'])}"
                    )
                    print_model_usage(s["model_usage"], indent="      ")

        grand_cost += proj_cost
        grand_duration += proj_duration
        grand_api_time += proj_api_time
        grand_session_count += proj_session_count
        merge_usage(grand_usage, proj_usage)

    # ── Grand summary ─────────────────────────────────────────────────────────
    grand_user_time = grand_duration - grand_api_time
    print(f"\n{'─'*60}")
    print(f"{BOLD}SUMMARY{RESET}  {grand_session_count} sessions across {len(data)} projects")
    print(f"  Total duration : {fmt_duration(grand_duration)} "
          f"(user: {fmt_duration(grand_user_time)}, assistant: {fmt_duration(grand_api_time)})")
    print(f"  Total cost     : {fmt_cost(grand_cost)}")
    print(f"\n  {BOLD}Model breakdown:{RESET}")
    print_model_usage(grand_usage, indent="    ")
    print()


if __name__ == "__main__":
    main()
