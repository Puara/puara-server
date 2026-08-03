#!/usr/bin/env bash
#
# combine-gestures-prs.sh — assemble a puara-gestures test branch from chosen PRs.
#
# This branch (gesture-tester) compiles the native addon against a checkout of
# puara-gestures on disk, so testing unmerged library work means putting that
# work into that checkout. Descriptors and utils arrive as one PR each, so this
# script fetches the PRs you name, merges them onto a branch there, and leaves
# the checkout ready for `npm run build:native`.
#
# The checkout it drives is the same one the addon build resolves:
#   --path DIR  >  $PUARA_GESTURES_PATH  >  ../puara-gestures (sibling of this repo)
# It is cloned if missing.
#
# Examples:
#   # every open puara-gestures PR except #135, then rebuild the addon
#   ./scripts/combine-gestures-prs.sh --all --exclude 135 --build
#
#   # only these three, onto a named branch
#   ./scripts/combine-gestures-prs.sh -b test-ribbon 118 121 134
#
#   # see the plan, change nothing
#   ./scripts/combine-gestures-prs.sh --all -x 135 --dry-run
#
# Requires: git, gh (authenticated).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_ROOT="$(dirname "$SCRIPT_DIR")"

GESTURES_REPO="Puara/puara-gestures"
GESTURES_PATH=""
BRANCH="combined-prs"
BASE="origin/main"
REMOTE="origin"
DRY_RUN=0
FORCE=0
ALL=0
BUILD=0
SUBMODULES=1
CLONE=1
declare -a WANT=()
declare -a EXCLUDE=()

# Files every descriptor/util PR touches additively (one new include, README
# bullet, or test source line each). A union merge concatenates both sides
# instead of conflicting, which is the right resolution for append-only edits.
declare -a UNION_FILES=(
  "README.md"
  "include/puara/gestures.h"
  "include/puara/utils.h"
  "tests/CMakeLists.txt"
  "tests/test_utils.cpp"
)

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage: combine-gestures-prs.sh [options] [PR_NUMBER...]

Merges the named puara-gestures PRs onto a branch in the puara-gestures
checkout that this branch's native addon compiles against.

Options:
  -b, --branch NAME     Branch to create in puara-gestures (default: combined-prs)
  -p, --path DIR        puara-gestures checkout to use
                        (default: $PUARA_GESTURES_PATH, else ../puara-gestures)
      --base REF        Base to branch from (default: origin/main)
      --repo OWNER/NAME Library repo the PRs live in (default: Puara/puara-gestures)
      --remote NAME     Remote in the checkout to fetch from (default: origin)
  -a, --all             Use every open PR (implied when no numbers are given)
  -x, --exclude N       Exclude a PR; repeatable, or comma-separated (-x 135,120)
  -u, --union-file P    Extra path to merge with the union driver; repeatable
      --build           Run 'npm run build:native' against the result
  -f, --force           Overwrite BRANCH if it already exists
      --no-submodules   Skip 'git submodule update --init --recursive'
      --no-clone        Fail instead of cloning a missing checkout
  -n, --dry-run         Print the plan and exit without touching anything
  -l, --list            List open puara-gestures PRs and exit
  -h, --help            Show this help

Merges happen in ascending PR order, each with --no-ff, so every PR stays a
distinct merge commit. On conflict the script aborts that merge and exits
non-zero, naming the PR and the conflicted files.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -b|--branch)     BRANCH="${2:?missing value for $1}"; shift 2 ;;
    -p|--path)       GESTURES_PATH="${2:?missing value for $1}"; shift 2 ;;
    --base)          BASE="${2:?missing value for $1}"; shift 2 ;;
    --repo)          GESTURES_REPO="${2:?missing value for $1}"; shift 2 ;;
    --remote)        REMOTE="${2:?missing value for $1}"; shift 2 ;;
    -a|--all)        ALL=1; shift ;;
    -x|--exclude)    IFS=', ' read -r -a _ex <<< "${2:?missing value for $1}"
                     EXCLUDE+=("${_ex[@]}"); shift 2 ;;
    -u|--union-file) UNION_FILES+=("${2:?missing value for $1}"); shift 2 ;;
    --build)         BUILD=1; shift ;;
    -f|--force)      FORCE=1; shift ;;
    --no-submodules) SUBMODULES=0; shift ;;
    --no-clone)      CLONE=0; shift ;;
    -n|--dry-run)    DRY_RUN=1; shift ;;
    -l|--list)       gh pr list --repo "$GESTURES_REPO" --state open --limit 100 \
                       --json number,title,headRefName \
                       --template '{{range .}}#{{.number}}  {{.headRefName}}  {{.title}}{{"\n"}}{{end}}'
                     exit 0 ;;
    -h|--help)       usage; exit 0 ;;
    -*)              die "unknown option: $1" ;;
    *)               [[ "$1" =~ ^[0-9]+$ ]] || die "not a PR number: $1"
                     WANT+=("$1"); shift ;;
  esac
done

command -v git >/dev/null || die "git not found"
command -v gh  >/dev/null || die "gh not found (https://cli.github.com)"

# ------------------------------------------------- resolve the library checkout
# Same precedence native/gestures-path.cjs uses, so the branch this produces is
# the one the addon will actually compile.
if [[ -z "$GESTURES_PATH" ]]; then
  GESTURES_PATH="${PUARA_GESTURES_PATH:-$SERVER_ROOT/../puara-gestures}"
fi
if [[ -e "$GESTURES_PATH" && ! -d "$GESTURES_PATH" ]]; then
  die "$GESTURES_PATH exists but is not a directory"
elif [[ -d "$GESTURES_PATH" ]]; then
  GESTURES_PATH="$(cd "$GESTURES_PATH" && pwd)" || die "cannot enter $GESTURES_PATH"
else
  GESTURES_PATH="$(cd "$(dirname "$GESTURES_PATH")" 2>/dev/null && pwd)/$(basename "$GESTURES_PATH")" \
    || die "cannot resolve $GESTURES_PATH"
fi

# ---------------------------------------------------------------- PR selection
if [[ ${#WANT[@]} -eq 0 ]]; then
  ALL=1
fi

if [[ $ALL -eq 1 ]]; then
  mapfile -t OPEN < <(gh pr list --repo "$GESTURES_REPO" --state open --limit 100 \
                        --json number -q '.[].number')
  [[ ${#OPEN[@]} -gt 0 ]] || die "no open PRs found in $GESTURES_REPO"
  WANT+=("${OPEN[@]}")
fi

# Drop exclusions and duplicates, then sort ascending so merge order is stable.
declare -a PRS=()
for n in "${WANT[@]}"; do
  skip=0
  for x in "${EXCLUDE[@]:-}"; do
    [[ "$n" == "$x" ]] && { skip=1; break; }
  done
  [[ $skip -eq 1 ]] && continue
  for seen in "${PRS[@]:-}"; do
    [[ "$n" == "$seen" ]] && { skip=1; break; }
  done
  [[ $skip -eq 1 ]] || PRS+=("$n")
done
[[ ${#PRS[@]} -gt 0 ]] || die "PR set is empty after exclusions"
mapfile -t PRS < <(printf '%s\n' "${PRS[@]}" | sort -n)

# Titles for readable merge commit messages (one API call, tolerate misses).
declare -A TITLE=()
while IFS=$'\t' read -r num title; do
  [[ -n "${num:-}" ]] && TITLE["$num"]="$title"
done < <(gh pr list --repo "$GESTURES_REPO" --state all --limit 200 \
           --json number,title \
           --template '{{range .}}{{.number}}{{"\t"}}{{.title}}{{"\n"}}{{end}}')

info "library:  $GESTURES_REPO"
info "checkout: $GESTURES_PATH"
info "base:     $BASE"
info "branch:   $BRANCH"
info "PRs (${#PRS[@]}): ${PRS[*]}"
[[ ${#EXCLUDE[@]} -gt 0 ]] && info "excluded: ${EXCLUDE[*]}"
info ""

if [[ $DRY_RUN -eq 1 ]]; then
  info "dry run — merge order would be:"
  for n in "${PRS[@]}"; do
    info "  #$n  ${TITLE[$n]:-<unknown title>}"
  done
  [[ -d "$GESTURES_PATH/.git" ]] || info "(checkout would be cloned first)"
  exit 0
fi

# ------------------------------------------------------------ clone if missing
if [[ ! -d "$GESTURES_PATH/.git" ]]; then
  [[ $CLONE -eq 1 ]] || die "no checkout at $GESTURES_PATH (--no-clone was passed)"
  [[ -e "$GESTURES_PATH" ]] && die "$GESTURES_PATH exists but is not a git checkout"
  info "cloning $GESTURES_REPO into $GESTURES_PATH ..."
  git clone --recursive "https://github.com/$GESTURES_REPO" "$GESTURES_PATH" --quiet \
    || die "clone failed"
fi

git -C "$GESTURES_PATH" rev-parse --git-dir >/dev/null 2>&1 \
  || die "$GESTURES_PATH is not a git repository"

# This script creates branches and merges in that directory, so confirm it is
# the library and not some other checkout a stale env var points at.
origin_url="$(git -C "$GESTURES_PATH" remote get-url "$REMOTE" 2>/dev/null || true)"
slug="${GESTURES_REPO#*/}"
if [[ "$origin_url" != *"$slug"* ]]; then
  die "$GESTURES_PATH remote '$REMOTE' is ${origin_url:-unset}, which does not look like $GESTURES_REPO
       pass --path to point at the right checkout, or --repo if your fork is named differently"
fi

# ------------------------------------------------------------- guard that tree
if ! git -C "$GESTURES_PATH" diff --quiet \
   || ! git -C "$GESTURES_PATH" diff --cached --quiet; then
  die "$GESTURES_PATH has uncommitted changes; commit or stash them first"
fi
if git -C "$GESTURES_PATH" show-ref --verify --quiet "refs/heads/$BRANCH" \
   && [[ $FORCE -eq 0 ]]; then
  die "branch '$BRANCH' already exists in $GESTURES_PATH (pass --force to overwrite)"
fi

# --------------------------------------------- union merge driver (temporary)
GITDIR="$(git -C "$GESTURES_PATH" rev-parse --absolute-git-dir)"
ATTR="$GITDIR/info/attributes"
ATTR_BAK=""
mkdir -p "$GITDIR/info"
if [[ -f "$ATTR" ]]; then
  ATTR_BAK="$ATTR.combine-prs-bak.$$"
  cp "$ATTR" "$ATTR_BAK"
fi
restore_attributes() {
  if [[ -n "$ATTR_BAK" ]]; then
    mv -f "$ATTR_BAK" "$ATTR"
  else
    rm -f "$ATTR"
  fi
}
trap restore_attributes EXIT

for f in "${UNION_FILES[@]}"; do
  printf '%s merge=union\n' "$f"
done > "$ATTR"

# ------------------------------------------------------------------- fetch
info "fetching $REMOTE ..."
git -C "$GESTURES_PATH" fetch "$REMOTE" --prune --quiet

# refs/pull/N/head works for PRs from forks as well as from branches in the repo.
for n in "${PRS[@]}"; do
  git -C "$GESTURES_PATH" fetch "$REMOTE" --quiet --force \
    "refs/pull/$n/head:refs/remotes/pr/$n" \
    || die "cannot fetch PR #$n from $GESTURES_REPO (does it exist?)"
done

# ------------------------------------------------------------------- merge
git -C "$GESTURES_PATH" checkout --quiet -B "$BRANCH" "$BASE"

declare -a MERGED=()
for n in "${PRS[@]}"; do
  title="${TITLE[$n]:-}"
  msg="Merge PR #$n${title:+: $title}"
  if git -C "$GESTURES_PATH" merge --no-ff --quiet -m "$msg" \
       "refs/remotes/pr/$n" >/dev/null 2>&1; then
    printf '  ok        #%-4s %s\n' "$n" "$title" >&2
    MERGED+=("$n")
  else
    printf '  CONFLICT  #%-4s %s\n' "$n" "$title" >&2
    info ""
    info "conflicted files:"
    git -C "$GESTURES_PATH" diff --name-only --diff-filter=U | sed 's/^/  /' >&2
    git -C "$GESTURES_PATH" merge --abort || true
    info ""
    info "merged so far: ${MERGED[*]:-none}"
    info "branch '$BRANCH' is left at the last good merge."
    info "Resolve by hand:  git -C '$GESTURES_PATH' merge refs/remotes/pr/$n"
    info "Or skip this PR:  re-run with --force -x $n"
    exit 1
  fi
done

# ------------------------------------------------------------------- verify
info ""
if git -C "$GESTURES_PATH" grep -In -e '^<<<<<<< ' -e '^>>>>>>> ' \
     -- ':!3rdparty' >/dev/null 2>&1; then
  info "WARNING: conflict markers found in the tree:"
  git -C "$GESTURES_PATH" grep -In -e '^<<<<<<< ' -e '^>>>>>>> ' -- ':!3rdparty' \
    | sed 's/^/  /' >&2
fi

# The addon compiles 3rdparty/IMU_Sensor_Fusion and includes Eigen, so a clone
# without submodules fails the check in native/gestures-path.cjs.
if [[ $SUBMODULES -eq 1 ]]; then
  info "updating submodules ..."
  git -C "$GESTURES_PATH" submodule update --init --recursive --quiet
fi

added=$(git -C "$GESTURES_PATH" diff --name-status "$BASE...HEAD" | grep -c '^A' || true)
noun="PRs"; [[ ${#MERGED[@]} -eq 1 ]] && noun="PR"
info ""
info "$GESTURES_PATH is on '$BRANCH': ${#MERGED[@]} $noun merged, $added files added."

# ------------------------------------------------------------------- rebuild
if [[ $BUILD -eq 1 ]]; then
  info ""
  info "rebuilding the addon ..."
  if PUARA_GESTURES_PATH="$GESTURES_PATH" npm --prefix "$SERVER_ROOT" \
       run build:native >/tmp/puara-addon-build.log 2>&1; then
    info "addon built — start with ./scripts/start.sh"
  else
    info "addon build FAILED — see /tmp/puara-addon-build.log"
    info "the merge itself is fine; this is a compile error in the combined set"
    tail -20 /tmp/puara-addon-build.log >&2
    exit 1
  fi
else
  info "next: PUARA_GESTURES_PATH='$GESTURES_PATH' npm run build:native"
fi

info ""
info "reproduce: ./scripts/combine-gestures-prs.sh -f -b $BRANCH --base $BASE ${PRS[*]}"
