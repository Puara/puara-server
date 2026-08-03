# `combine-gestures-prs.sh` — test unmerged puara-gestures PRs here

Assembles a branch in your [puara-gestures](https://github.com/Puara/puara-gestures)
checkout from the PRs you name, so the native addon can be built against several
pieces of unmerged library work at once.

This exists because of how [gesture-tester](./GESTURE-TESTER.md) consumes the
library: the addon compiles headers straight out of a checkout on disk, so
"test that PR" means "get that PR into that checkout". Descriptors and utils
arrive as one PR each, and merging a dozen branches by hand — resolving the same
trivial conflicts every time — is the part worth scripting.

```sh
./scripts/combine-gestures-prs.sh --all --exclude 135 --build
```

That fetches every open puara-gestures PR except #135, merges them onto a
`combined-prs` branch in the checkout, updates its submodules, and rebuilds the
addon. Then `./scripts/start.sh` and the C++ descriptors from those PRs are live
on `/puara/gestures/...`.

## Requirements

- `git`
- [`gh`](https://cli.github.com), authenticated (`gh auth login`) — it reads the
  PR list and titles from the puara-gestures repo
- a C++ toolchain, if you pass `--build` (same requirement as `install.sh`)

Run it from anywhere; it locates this repo from its own path.

## Which checkout it touches

The same one the addon build resolves, in the same order — see
`native/gestures-path.cjs`:

1. `--path DIR`
2. `$PUARA_GESTURES_PATH`
3. `../puara-gestures`, a sibling of this repo

If nothing is there it clones `Puara/puara-gestures` with `--recursive`
(`--no-clone` to refuse instead). Before creating anything it checks that the
directory's remote actually looks like puara-gestures, so a stale
`PUARA_GESTURES_PATH` cannot end up with branches merged into an unrelated repo.

**This switches branches in that checkout.** It refuses to run if the checkout
has uncommitted tracked changes.

## Usage

```sh
# every open PR except one — the usual "test everything pending" run
./scripts/combine-gestures-prs.sh --all -x 135 --build

# a specific set, by number, on a branch of its own
./scripts/combine-gestures-prs.sh -b test-ribbon 118 121 134 --build

# what is open right now
./scripts/combine-gestures-prs.sh --list

# print the merge order and exit, touching nothing
./scripts/combine-gestures-prs.sh --all -x 135 --dry-run

# a clone somewhere else
./scripts/combine-gestures-prs.sh -p ~/src/puara-gestures 118 134
```

With no PR numbers, `--all` is implied: `combine-gestures-prs.sh -x 135` and
`combine-gestures-prs.sh --all -x 135` do the same thing.

| Option | Meaning |
| --- | --- |
| `-b, --branch NAME` | Branch to create in puara-gestures. Default `combined-prs`. |
| `-p, --path DIR` | Checkout to use. Overrides `$PUARA_GESTURES_PATH`. |
| `--base REF` | What to branch from. Default `origin/main`. |
| `--repo OWNER/NAME` | Library repo the PRs live in. Default `Puara/puara-gestures`. |
| `--remote NAME` | Remote in the checkout to fetch from. Default `origin`. |
| `-a, --all` | Use every open PR. Implied when no numbers are given. |
| `-x, --exclude N` | Exclude a PR. Repeatable, or comma-separated: `-x 135,120`. |
| `-u, --union-file P` | Add a path to the union-merge list (below). Repeatable. |
| `--build` | Run `npm run build:native` against the result. |
| `-f, --force` | Overwrite the branch if it already exists. |
| `--no-submodules` | Skip `git submodule update --init --recursive`. |
| `--no-clone` | Fail instead of cloning a missing checkout. |
| `-n, --dry-run` | Print the plan and exit. |
| `-l, --list` | List open PRs and exit. |
| `-h, --help` | Usage. |

## What it does

1. Resolves (or clones) the checkout and confirms it is the library.
2. Fetches each PR as `refs/pull/N/head` → `refs/remotes/pr/N`. That form works
   for PRs from forks as well as from branches in the repo.
3. Creates `--branch` at `--base`.
4. Merges the PRs in **ascending number order**, each with `--no-ff`, so every
   PR stays a distinct merge commit named `Merge PR #N: <title>`.
5. Updates submodules — the addon compiles `3rdparty/IMU_Sensor_Fusion` and
   includes Eigen, and `native/gestures-path.cjs` rejects a checkout missing
   either.
6. Rebuilds the addon with `--build`, or otherwise prints the command to do it.

The last line of output is the command that reproduces the branch exactly.

### Union merges

Every descriptor/util PR is purely additive: a new header, a new example sketch,
a new test file, plus a one-line insert into a few shared files. Those inserts
land in the same place in every PR, so a plain merge conflicts on all of them
even though both sides only ever add.

So the script installs a
[union merge driver](https://git-scm.com/docs/gitattributes#_built_in_merge_drivers)
for these paths:

- `README.md`
- `include/puara/gestures.h`
- `include/puara/utils.h`
- `tests/CMakeLists.txt`
- `tests/test_utils.cpp`

A union merge keeps **both** sides rather than conflicting, which is the correct
resolution for append-only edits. Add paths with `-u` if a future PR set needs
them.

It is written to the checkout's `.git/info/attributes`, which is local and
untracked, so it never becomes a commit. Any pre-existing file there is backed
up and restored, and the restore runs even when the script fails partway.

One cosmetic consequence: union merges append in merge order, so the new
`#include` lines in `gestures.h` and `utils.h` come out unsorted. Harmless to
compile; a `clang-format` job on the library may flag it.

## When a merge conflicts

The script stops at the first conflict, reports the PR and the conflicted files,
aborts that one merge, and leaves the branch at the last successful merge. It
exits non-zero.

From there, either resolve it yourself:

```sh
git -C ../puara-gestures merge refs/remotes/pr/121   # fix, git add, git commit
```

or drop that PR and rebuild:

```sh
./scripts/combine-gestures-prs.sh -f -b combined-prs --all -x 135 -x 121
```

A real conflict — two PRs changing the same logic rather than both appending — is
worth reporting on the PRs themselves, since it will bite whoever merges them
second.

## When the build fails

A merge that succeeds can still not compile: two PRs may each build alone and
clash semantically, or one may simply be broken. `--build` reports that
separately from a merge failure and leaves the full log at
`/tmp/puara-addon-build.log`.

That is a useful result, not a script failure — it is the reason this branch
exists. Bisect by rerunning with fewer PRs:

```sh
./scripts/combine-gestures-prs.sh -f -b bisect 118 121 --build
```

## Safety

- Refuses to run if the checkout has uncommitted tracked changes.
- Refuses to overwrite an existing branch without `--force`.
- Refuses to act on a directory whose remote does not look like the library.
- An unknown PR number fails during fetch, before any branch is created.
- Nothing is pushed, and nothing is merged into anyone's `main`. The output is a
  local branch in your checkout; `git -C ../puara-gestures branch -D <branch>`
  undoes the whole run.
